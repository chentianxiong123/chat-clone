import argparse
import hashlib
import json
from pathlib import Path


DEFAULT_INPUTS = [
    Path("workspace/06_final_segments/final_segments/final_segments_v1_allowed.jsonl"),
    Path("workspace/06_final_segments/final_segments/final_segments_v1_manual_review.jsonl"),
]
DEFAULT_OUTPUT = Path("workspace/07_rag_embedding/retrieval_docs/retrieval_docs_v1.jsonl")
DEFAULT_TARGET_HASH_PREFIX = "733362163ba0"


def sender_hash(sender: str) -> str:
    return hashlib.sha256(sender.encode("utf-8")).hexdigest()


def role_for_sender(sender: str, target_hash_prefix: str) -> str:
    return "assistant" if sender_hash(sender or "").startswith(target_hash_prefix) else "user"


def date_from_segment(segment: dict) -> str:
    value = segment.get("start") or segment.get("end") or ""
    return value[:10] if len(value) >= 10 else "unknown"


def nonempty_messages(segment: dict, target_hash_prefix: str) -> list[tuple[int, str]]:
    rows = []
    for index, message in enumerate(segment.get("messages") or []):
        text = message.get("text")
        if not isinstance(text, str) or not text.strip():
            continue
        role = role_for_sender(message.get("sender") or "", target_hash_prefix)
        rows.append((index, f"{role}: {text.strip()}"))
    return rows


def split_long_line(line: str, max_chars: int) -> list[str]:
    if len(line) <= max_chars:
        return [line]
    prefix, sep, body = line.partition(": ")
    label = prefix + sep if sep else ""
    if not body:
        body = line
        label = ""
    limit = max(200, max_chars - len(label))
    return [label + body[i : i + limit] for i in range(0, len(body), limit)]


def build_chunks(
    segment: dict,
    target_hash_prefix: str,
    max_chars: int,
    max_messages: int,
    overlap_messages: int,
) -> list[dict]:
    date = date_from_segment(segment)
    lines_with_index = []
    for message_index, line in nonempty_messages(segment, target_hash_prefix):
        for split_line in split_long_line(line, max_chars):
            lines_with_index.append((message_index, split_line))

    if not lines_with_index:
        return []

    chunks = []
    start = 0
    chunk_index = 0
    while start < len(lines_with_index):
        current = []
        current_chars = 0
        cursor = start
        while cursor < len(lines_with_index):
            _, line = lines_with_index[cursor]
            add_chars = len(line) + (1 if current else 0)
            if current and (current_chars + add_chars > max_chars or len(current) >= max_messages):
                break
            current.append(lines_with_index[cursor])
            current_chars += add_chars
            cursor += 1

        text = "\n".join(line for _, line in current)
        embed_text = f"date: {date}\n\n{text}"
        text_hash = hashlib.sha256(embed_text.encode("utf-8")).hexdigest()
        segment_id = segment.get("segment_id") or "segment"
        chunk_id = f"{segment_id}::chunk{chunk_index:04d}"
        chunks.append(
            {
                "chunk_id": chunk_id,
                "date": date,
                "text": text,
                "embed_text": embed_text,
                "text_hash": text_hash,
                "char_count": len(text),
                "message_count": len(current),
            }
        )

        chunk_index += 1
        if cursor >= len(lines_with_index):
            break
        start = max(cursor - overlap_messages, start + 1)

    return chunks


def build_retrieval_docs(args: argparse.Namespace) -> dict:
    args.output.parent.mkdir(parents=True, exist_ok=True)
    stats = {
        "inputs": [str(path) for path in args.input],
        "output": str(args.output),
        "segments": 0,
        "empty_segments": 0,
        "chunks": 0,
        "duplicate_text_hash": 0,
    }
    seen_hashes = set()
    with args.output.open("w", encoding="utf-8", newline="\n") as out:
        for input_path in args.input:
            with input_path.open("r", encoding="utf-8") as f:
                for line in f:
                    if not line.strip():
                        continue
                    stats["segments"] += 1
                    segment = json.loads(line)
                    chunks = build_chunks(
                        segment,
                        target_hash_prefix=args.target_hash_prefix,
                        max_chars=args.max_chars,
                        max_messages=args.max_messages,
                        overlap_messages=args.overlap_messages,
                    )
                    if not chunks:
                        stats["empty_segments"] += 1
                        continue
                    for chunk in chunks:
                        if chunk["text_hash"] in seen_hashes:
                            stats["duplicate_text_hash"] += 1
                            continue
                        seen_hashes.add(chunk["text_hash"])
                        out.write(json.dumps(chunk, ensure_ascii=False, separators=(",", ":")) + "\n")
                        stats["chunks"] += 1

    if args.summary:
        args.summary.parent.mkdir(parents=True, exist_ok=True)
        args.summary.write_text(json.dumps(stats, ensure_ascii=False, indent=2), encoding="utf-8")
    return stats


def main() -> None:
    parser = argparse.ArgumentParser(description="Build minimal retrieval docs from final chat segments.")
    parser.add_argument("--input", type=Path, action="append", default=[])
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument(
        "--summary",
        type=Path,
        default=Path("workspace/07_rag_embedding/retrieval_docs/retrieval_docs_v1.summary.json"),
    )
    parser.add_argument("--target-hash-prefix", default=DEFAULT_TARGET_HASH_PREFIX)
    parser.add_argument("--max-chars", type=int, default=1200)
    parser.add_argument("--max-messages", type=int, default=80)
    parser.add_argument("--overlap-messages", type=int, default=3)
    parser.add_argument("--limit", type=int, default=0, help="Only write the first N chunks for smoke tests.")
    args = parser.parse_args()
    if not args.input:
        args.input = DEFAULT_INPUTS

    stats = build_retrieval_docs(args)
    if args.limit:
        rows = []
        with args.output.open("r", encoding="utf-8") as f:
            for _, line in zip(range(args.limit), f):
                rows.append(line)
        args.output.write_text("".join(rows), encoding="utf-8")
        stats["chunks"] = len(rows)
        stats["limited_to"] = args.limit
        if args.summary:
            args.summary.write_text(json.dumps(stats, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(stats, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
