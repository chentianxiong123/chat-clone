import argparse
import json
import random
import re
from collections import Counter, defaultdict
from pathlib import Path


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


def clean_text(value):
    text = "" if value is None else str(value)
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    text = CONTROL_CHARS.sub("", text)
    return text.strip()


def is_bad_text(text):
    return not text or URL_RE.search(text) or CODEISH_RE.search(text)


def response_weight(text):
    length = len(text)
    if length <= 4:
        return 2
    return 1


def main():
    parser = argparse.ArgumentParser(description="Build pure distribution prompt/response SFT.")
    parser.add_argument("--input", type=Path, nargs="+", required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--target-sender", required=True)
    parser.add_argument("--prompt", default="T:")
    parser.add_argument("--min-chars", type=int, default=1)
    parser.add_argument("--max-chars", type=int, default=20)
    parser.add_argument("--response-cap", type=int, default=30)
    parser.add_argument("--max-samples", type=int, default=10000)
    parser.add_argument("--val-ratio", type=float, default=0.01)
    parser.add_argument("--seed", type=int, default=20260706)
    parser.add_argument("--no-short-weight", action="store_true")
    args = parser.parse_args()

    rng = random.Random(args.seed)
    stats = Counter()
    by_response = defaultdict(int)
    candidates = []

    for path in args.input:
        for _, row in iter_jsonl(path):
            stats["rows_total"] += 1
            if str(row.get("sender", "")) != args.target_sender:
                stats["skip_not_target"] += 1
                continue
            if str(row.get("type", "")) != "text":
                stats["skip_non_text"] += 1
                continue
            text = clean_text(row.get("text", ""))
            if is_bad_text(text):
                stats["skip_bad_text"] += 1
                continue
            if len(text) < args.min_chars or len(text) > args.max_chars:
                stats["skip_len"] += 1
                continue
            if args.response_cap > 0 and by_response[text] >= args.response_cap:
                stats["skip_response_cap"] += 1
                continue
            by_response[text] += 1
            weight = 1 if args.no_short_weight else response_weight(text)
            for _ in range(weight):
                candidates.append({"prompt": args.prompt, "response": text})
            stats["kept_unique_or_capped"] += 1

    rng.shuffle(candidates)
    if args.max_samples > 0:
        candidates = candidates[: args.max_samples]

    args.output_dir.mkdir(parents=True, exist_ok=True)
    val_count = int(len(candidates) * args.val_ratio)
    val = candidates[:val_count]
    train = candidates[val_count:]

    for filename, rows in [("all.jsonl", candidates), ("train.jsonl", train), ("val.jsonl", val)]:
        with (args.output_dir / filename).open("w", encoding="utf-8", newline="\n") as f:
            for item in rows:
                f.write(json.dumps(item, ensure_ascii=False, separators=(",", ":")) + "\n")

    response_lengths = [len(x["response"]) for x in candidates]

    def percentile(values, p):
        if not values:
            return None
        values = sorted(values)
        return values[int((len(values) - 1) * p)]

    summary = {
        "output_dir": str(args.output_dir),
        "prompt": args.prompt,
        "min_chars": args.min_chars,
        "max_chars": args.max_chars,
        "response_cap": args.response_cap,
        "max_samples": args.max_samples,
        "samples_total": len(candidates),
        "train_samples": len(train),
        "val_samples": len(val),
        "response_chars": {
            "p50": percentile(response_lengths, 0.50),
            "p90": percentile(response_lengths, 0.90),
            "max": max(response_lengths) if response_lengths else None,
        },
        "stats": dict(sorted(stats.items())),
    }
    (args.output_dir / "summary.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    print(json.dumps(summary, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
