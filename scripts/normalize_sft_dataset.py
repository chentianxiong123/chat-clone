import argparse
import hashlib
import json
import random
from collections import Counter
from pathlib import Path


DEFAULT_INPUT = Path("workspace/08_sft_datasets/train_sets/train_sft_v1_allowed.jsonl")
DEFAULT_OUTPUT_DIR = Path("workspace/08_sft_datasets/train_sets/final_sft_v1")
DEFAULT_SEED = 20260705


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


def write_jsonl(path, rows):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="\n") as f:
        for row in rows:
            f.write(json.dumps(row, ensure_ascii=False, separators=(",", ":")) + "\n")


def normalize_text(value):
    text = "" if value is None else str(value)
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    lines = [line.rstrip() for line in text.split("\n")]
    return "\n".join(lines).strip()


def normalize_row(row):
    messages = row.get("messages")
    if not isinstance(messages, list) or len(messages) != 3:
        return None, "bad_message_shape"

    normalized = []
    expected_roles = ["system", "user", "assistant"]
    for index, expected_role in enumerate(expected_roles):
        item = messages[index]
        if not isinstance(item, dict):
            return None, "bad_message_item"
        role = str(item.get("role", "")).strip()
        if role != expected_role:
            return None, "bad_role_order"
        content = normalize_text(item.get("content", ""))
        if not content:
            return None, f"empty_{expected_role}"
        normalized.append({"role": role, "content": content})

    return {"messages": normalized}, None


def row_key(row):
    payload = json.dumps(row, ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def percentile(values, p):
    if not values:
        return None
    sorted_values = sorted(values)
    index = int((len(sorted_values) - 1) * p)
    return sorted_values[index]


def summarize_lengths(rows):
    user_chars = [len(row["messages"][1]["content"]) for row in rows]
    assistant_chars = [len(row["messages"][2]["content"]) for row in rows]
    return {
        "user_chars": {
            "p50": percentile(user_chars, 0.50),
            "p90": percentile(user_chars, 0.90),
            "p95": percentile(user_chars, 0.95),
            "p99": percentile(user_chars, 0.99),
            "max": max(user_chars) if user_chars else None,
        },
        "assistant_chars": {
            "p50": percentile(assistant_chars, 0.50),
            "p90": percentile(assistant_chars, 0.90),
            "p95": percentile(assistant_chars, 0.95),
            "p99": percentile(assistant_chars, 0.99),
            "max": max(assistant_chars) if assistant_chars else None,
        },
    }


def normalize_dataset(
    input_path,
    output_dir,
    val_ratio,
    seed,
    min_user_chars,
    max_user_chars,
    min_assistant_chars,
    max_assistant_chars,
):
    stats = Counter()
    rows = []
    seen = set()

    for _, raw_row in iter_jsonl(input_path):
        stats["input_rows"] += 1
        row, error = normalize_row(raw_row)
        if error:
            stats[f"skip_{error}"] += 1
            continue

        user_len = len(row["messages"][1]["content"])
        assistant_len = len(row["messages"][2]["content"])
        if user_len < min_user_chars:
            stats["skip_user_too_short"] += 1
            continue
        if max_user_chars > 0 and user_len > max_user_chars:
            stats["skip_user_too_long"] += 1
            continue
        if assistant_len < min_assistant_chars:
            stats["skip_assistant_too_short"] += 1
            continue
        if max_assistant_chars > 0 and assistant_len > max_assistant_chars:
            stats["skip_assistant_too_long"] += 1
            continue

        key = row_key(row)
        if key in seen:
            stats["skip_duplicate"] += 1
            continue
        seen.add(key)
        rows.append(row)

    rng = random.Random(seed)
    rng.shuffle(rows)

    val_count = int(len(rows) * val_ratio)
    val_rows = rows[:val_count]
    train_rows = rows[val_count:]

    output_dir.mkdir(parents=True, exist_ok=True)
    train_path = output_dir / "train.jsonl"
    val_path = output_dir / "val.jsonl"
    summary_path = output_dir / "summary.json"

    write_jsonl(train_path, train_rows)
    write_jsonl(val_path, val_rows)

    summary = {
        "input": str(input_path),
        "output_dir": str(output_dir),
        "train": str(train_path),
        "val": str(val_path),
        "seed": seed,
        "val_ratio": val_ratio,
        "filters": {
            "min_user_chars": min_user_chars,
            "max_user_chars": max_user_chars,
            "min_assistant_chars": min_assistant_chars,
            "max_assistant_chars": max_assistant_chars,
        },
        "input_rows": stats["input_rows"],
        "kept_rows": len(rows),
        "train_rows": len(train_rows),
        "val_rows": len(val_rows),
        "skips": {
            key: value
            for key, value in sorted(stats.items())
            if key.startswith("skip_")
        },
        "lengths_all": summarize_lengths(rows),
        "lengths_train": summarize_lengths(train_rows),
        "lengths_val": summarize_lengths(val_rows),
    }
    summary_path.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=False, indent=2))


def main():
    parser = argparse.ArgumentParser(description="Normalize SFT jsonl into final train/val files.")
    parser.add_argument("--input", type=Path, default=DEFAULT_INPUT)
    parser.add_argument("--output-dir", type=Path, default=DEFAULT_OUTPUT_DIR)
    parser.add_argument("--val-ratio", type=float, default=0.01)
    parser.add_argument("--seed", type=int, default=DEFAULT_SEED)
    parser.add_argument("--min-user-chars", type=int, default=1)
    parser.add_argument("--max-user-chars", type=int, default=0)
    parser.add_argument("--min-assistant-chars", type=int, default=1)
    parser.add_argument("--max-assistant-chars", type=int, default=1000)
    args = parser.parse_args()

    if args.val_ratio < 0 or args.val_ratio >= 1:
        raise SystemExit("--val-ratio must be >= 0 and < 1")

    normalize_dataset(
        input_path=args.input,
        output_dir=args.output_dir,
        val_ratio=args.val_ratio,
        seed=args.seed,
        min_user_chars=args.min_user_chars,
        max_user_chars=args.max_user_chars,
        min_assistant_chars=args.min_assistant_chars,
        max_assistant_chars=args.max_assistant_chars,
    )


if __name__ == "__main__":
    main()
