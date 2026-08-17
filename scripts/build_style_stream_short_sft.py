import argparse
import hashlib
import json
import random
import re
from collections import Counter
from datetime import datetime
from pathlib import Path


DEFAULT_OUTPUT_DIR = Path("workspace/08_sft_datasets/train_sets/style_stream_short_v1")
DEFAULT_SYSTEM_PROMPT = "按真实聊天时间流，只输出 assistant 的下一条短消息。"

CONTROL_CHARS = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f]")
URL_RE = re.compile(r"https?://|www\.", re.IGNORECASE)
CODEISH_RE = re.compile(r"```|#include|public static|def |class |function\s*\(|SELECT\s+", re.IGNORECASE)


def iter_jsonl(path):
    with path.open("r", encoding="utf-8") as f:
        for line_no, line in enumerate(f, 1):
            line = line.strip()
            if not line:
                continue
            try:
                yield line_no, json.loads(line)
            except json.JSONDecodeError as exc:
                raise ValueError(f"{path}:{line_no}: invalid json: {exc}") from exc


def write_jsonl_row(handle, row):
    handle.write(json.dumps(row, ensure_ascii=False, separators=(",", ":")) + "\n")


def clean_text(value):
    text = "" if value is None else str(value)
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    text = CONTROL_CHARS.sub("", text)
    return text.strip()


def stable_hash(value):
    return hashlib.sha256(str(value).encode("utf-8")).hexdigest()[:16]


def parse_dt(value):
    return datetime.strptime(value, "%Y-%m-%d %H:%M:%S")


def platform_from_path(path):
    name = path.name.lower()
    if "qq" in name:
        return "qq"
    if "wx" in name or "wechat" in name:
        return "wechat"
    return path.stem


def is_bad_training_text(text, drop_urls, drop_codeish):
    if not text:
        return True
    if drop_urls and URL_RE.search(text):
        return True
    if drop_codeish and CODEISH_RE.search(text):
        return True
    return False


def format_context_line(message, target_sender):
    label = "assistant" if message["sender"] == target_sender else "user"
    return f"{label}: {message['text']}"


def build_prompt(context, target_sender):
    lines = [format_context_line(message, target_sender) for message in context]
    lines.append("assistant:")
    return "\n".join(lines)


def build_row(context, target, target_sender, system_prompt, output_format):
    prompt = build_prompt(context, target_sender)
    completion = target["text"]
    if output_format == "completion":
        return {"prompt": prompt, "completion": completion}
    if output_format == "text":
        return {"text": f"{prompt} {completion}"}
    return {
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": prompt},
            {"role": "assistant", "content": completion},
        ]
    }


def percentile(values, p):
    if not values:
        return None
    sorted_values = sorted(values)
    index = int((len(sorted_values) - 1) * p)
    return sorted_values[index]


def should_keep_candidate(
    target,
    context,
    target_sender,
    max_context_chars,
    min_other_in_context,
):
    if max_context_chars > 0:
        if sum(len(m["text"]) for m in context) > max_context_chars:
            return False
    if min_other_in_context > 0:
        other_count = sum(1 for m in context if m["sender"] != target_sender)
        if other_count < min_other_in_context:
            return False
    return True


def build_dataset(
    input_paths,
    output_dir,
    target_sender,
    context_messages,
    min_context_messages,
    max_target_chars,
    max_context_chars,
    max_gap_minutes,
    max_samples,
    val_ratio,
    seed,
    output_format,
    system_prompt,
    drop_urls,
    drop_codeish,
    min_other_in_context,
):
    rng = random.Random(seed)
    output_dir.mkdir(parents=True, exist_ok=True)

    candidates = []
    stats = Counter()
    target_lengths = []
    context_char_lengths = []

    for input_path in input_paths:
        platform = platform_from_path(input_path)
        window = []
        previous_dt = None

        for _, raw in iter_jsonl(input_path):
            stats["rows_total"] += 1
            if str(raw.get("type", "")) != "text":
                stats["skip_non_text"] += 1
                continue

            text = clean_text(raw.get("text", ""))
            if is_bad_training_text(text, drop_urls=drop_urls, drop_codeish=drop_codeish):
                stats["skip_bad_text"] += 1
                continue

            try:
                current_dt = parse_dt(raw.get("time", ""))
            except Exception:
                stats["skip_bad_time"] += 1
                continue

            if previous_dt is not None:
                gap_sec = (current_dt - previous_dt).total_seconds()
                if gap_sec < 0 or gap_sec > max_gap_minutes * 60:
                    window.clear()
                    stats["session_break_gap"] += 1

            message = {
                "time": raw.get("time", ""),
                "sender": str(raw.get("sender", "")),
                "text": text,
                "platform": platform,
            }

            if message["sender"] == target_sender:
                if len(text) > max_target_chars:
                    stats["skip_long_target"] += 1
                else:
                    context = window[-context_messages:]
                    if len(context) < min_context_messages:
                        stats["skip_short_context"] += 1
                    elif should_keep_candidate(
                        target=message,
                        context=context,
                        target_sender=target_sender,
                        max_context_chars=max_context_chars,
                        min_other_in_context=min_other_in_context,
                    ):
                        candidates.append((context.copy(), message))
                        stats["candidates_total"] += 1
                        stats[f"candidates_platform_{platform}"] += 1
                        target_lengths.append(len(text))
                        context_char_lengths.append(sum(len(m["text"]) for m in context))
                    else:
                        stats["skip_context_filter"] += 1

            window.append(message)
            if len(window) > context_messages:
                window = window[-context_messages:]
            previous_dt = current_dt

    rng.shuffle(candidates)
    if max_samples > 0:
        candidates = candidates[:max_samples]

    val_count = int(len(candidates) * val_ratio)
    val = candidates[:val_count]
    train = candidates[val_count:]

    train_path = output_dir / "train.jsonl"
    val_path = output_dir / "val.jsonl"
    raw_path = output_dir / "all.jsonl"

    for path, rows in [(raw_path, candidates), (train_path, train), (val_path, val)]:
        with path.open("w", encoding="utf-8", newline="\n") as f:
            for context, target in rows:
                write_jsonl_row(
                    f,
                    build_row(
                        context=context,
                        target=target,
                        target_sender=target_sender,
                        system_prompt=system_prompt,
                        output_format=output_format,
                    ),
                )

    summary = {
        "inputs": [str(path) for path in input_paths],
        "output_dir": str(output_dir),
        "target_sender_hash": stable_hash(target_sender),
        "context_messages": context_messages,
        "min_context_messages": min_context_messages,
        "max_target_chars": max_target_chars,
        "max_context_chars": max_context_chars,
        "max_gap_minutes": max_gap_minutes,
        "max_samples": max_samples,
        "val_ratio": val_ratio,
        "seed": seed,
        "output_format": output_format,
        "drop_urls": drop_urls,
        "drop_codeish": drop_codeish,
        "min_other_in_context": min_other_in_context,
        "samples_total": len(candidates),
        "train_samples": len(train),
        "val_samples": len(val),
        "stats": dict(sorted(stats.items())),
        "target_chars": {
            "p50": percentile(target_lengths, 0.50),
            "p90": percentile(target_lengths, 0.90),
            "max": max(target_lengths) if target_lengths else None,
        },
        "context_chars": {
            "p50": percentile(context_char_lengths, 0.50),
            "p90": percentile(context_char_lengths, 0.90),
            "max": max(context_char_lengths) if context_char_lengths else None,
        },
    }
    summary_path = output_dir / "summary.json"
    summary_path.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=False, indent=2))


def main():
    parser = argparse.ArgumentParser(
        description="Build short stream-style next-message SFT directly from cleaned chat records."
    )
    parser.add_argument("--input", type=Path, nargs="+", required=True)
    parser.add_argument("--output-dir", type=Path, default=DEFAULT_OUTPUT_DIR)
    parser.add_argument("--target-sender", required=True)
    parser.add_argument("--context-messages", type=int, default=3)
    parser.add_argument("--min-context-messages", type=int, default=1)
    parser.add_argument("--max-target-chars", type=int, default=12)
    parser.add_argument("--max-context-chars", type=int, default=80, help="Use 0 to disable.")
    parser.add_argument("--max-gap-minutes", type=int, default=15)
    parser.add_argument("--max-samples", type=int, default=0, help="Use 0 for all candidates.")
    parser.add_argument("--val-ratio", type=float, default=0.01)
    parser.add_argument("--seed", type=int, default=20260706)
    parser.add_argument("--output-format", choices=["chat", "completion", "text"], default="completion")
    parser.add_argument("--system-prompt", default=DEFAULT_SYSTEM_PROMPT)
    parser.add_argument("--keep-urls", action="store_true")
    parser.add_argument("--keep-codeish", action="store_true")
    parser.add_argument("--min-other-in-context", type=int, default=0)
    args = parser.parse_args()

    if args.context_messages < 1:
        raise SystemExit("--context-messages must be >= 1")
    if args.min_context_messages < 0:
        raise SystemExit("--min-context-messages must be >= 0")
    if args.val_ratio < 0 or args.val_ratio >= 1:
        raise SystemExit("--val-ratio must be >= 0 and < 1")
    for input_path in args.input:
        if not input_path.exists():
            raise SystemExit(f"input not found: {input_path}")

    build_dataset(
        input_paths=args.input,
        output_dir=args.output_dir,
        target_sender=args.target_sender,
        context_messages=args.context_messages,
        min_context_messages=args.min_context_messages,
        max_target_chars=args.max_target_chars,
        max_context_chars=args.max_context_chars,
        max_gap_minutes=args.max_gap_minutes,
        max_samples=args.max_samples,
        val_ratio=args.val_ratio,
        seed=args.seed,
        output_format=args.output_format,
        system_prompt=args.system_prompt,
        drop_urls=not args.keep_urls,
        drop_codeish=not args.keep_codeish,
        min_other_in_context=args.min_other_in_context,
    )


if __name__ == "__main__":
    main()
