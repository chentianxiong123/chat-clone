import argparse
import json
import random
from pathlib import Path


DEFAULT_BUCKETS = ["15_30", "30_60", "gt_60"]


def iter_jsonl(path):
    with path.open("r", encoding="utf-8") as f:
        for line_no, line in enumerate(f, 1):
            line = line.strip()
            if not line:
                continue
            try:
                yield json.loads(line)
            except json.JSONDecodeError as exc:
                raise ValueError(f"{path}:{line_no}: invalid json: {exc}") from exc


def clean_line(text):
    return str(text).replace("\r", " ").replace("\n", " ").strip()


def transcript_lines(sample):
    lines = []
    for message in sample.get("left_messages", []):
        lines.append(format_message(message))

    lines.append("")
    lines.append(
        "--- 候选切分点："
        f"sample_id={sample.get('sample_id', '')}; "
        f"gap_min={sample.get('gap_min', '')}; "
        "请只判断这行前后相邻消息是否适合切开 ---"
    )
    lines.append("")

    for message in sample.get("right_messages", []):
        lines.append(format_message(message))
    return lines


def format_message(message):
    time = clean_line(message.get("time", ""))
    role = clean_line(message.get("role", ""))
    text = clean_line(message.get("text", ""))
    return f"[{time}] {role}: {text}"


def make_payload(samples):
    return {
        "task": "逐个判断候选切分点是否适合切开，用于后续训练上下文分段。",
        "decision_rule": "重点只看候选切分点前后相邻消息。其他消息只作为语气、节奏和上下文参考。不要判断整段聊天是否连续。",
        "output_only_json": True,
        "output_schema": [
            {
                "sample_id": "string",
                "cut": "cut_ok | not_cut",
                "confidence": "0.0-1.0",
                "reason": "不超过30字，只说明判断依据，不引用原文"
            }
        ],
        "samples": [
            {
                "sample_id": sample.get("sample_id"),
                "platform": sample.get("platform"),
                "bucket": sample.get("bucket"),
                "gap_min": sample.get("gap_min"),
                "transcript": "\n".join(transcript_lines(sample)),
            }
            for sample in samples
        ],
    }


def choose_samples(rows, buckets, rng):
    chosen = []
    used_ids = set()

    for bucket in buckets:
        candidates = [
            row for row in rows
            if row.get("bucket") == bucket and row.get("sample_id") not in used_ids
        ]
        if not candidates:
            continue
        sample = rng.choice(candidates)
        chosen.append(sample)
        used_ids.add(sample.get("sample_id"))

    if len(chosen) < len(buckets):
        remaining = [row for row in rows if row.get("sample_id") not in used_ids]
        rng.shuffle(remaining)
        for sample in remaining:
            chosen.append(sample)
            used_ids.add(sample.get("sample_id"))
            if len(chosen) >= len(buckets):
                break

    return chosen


def write_markdown(path, samples):
    lines = []
    lines.append("# 外援 API 边界试水样本")
    lines.append("")
    lines.append("任务：逐个判断候选切分点是否适合切开，用于后续训练上下文分段。")
    lines.append("")
    lines.append("重点：只看候选切分点前后相邻消息。其他消息只作为语气、节奏和上下文参考。不要判断整段聊天是否连续。")
    lines.append("")
    lines.append("只输出 JSON：")
    lines.append("")
    lines.append("```json")
    lines.append("[")
    lines.append("  {")
    lines.append('    "sample_id": "...",')
    lines.append('    "cut": "cut_ok | not_cut",')
    lines.append('    "confidence": 0.0,')
    lines.append('    "reason": "不超过30字，只说明判断依据，不引用原文"')
    lines.append("  }")
    lines.append("]")
    lines.append("```")
    lines.append("")

    for idx, sample in enumerate(samples, 1):
        lines.append(f"## 样本 {idx}")
        lines.append("")
        lines.append(f"- sample_id: `{sample.get('sample_id', '')}`")
        lines.append(f"- platform: `{sample.get('platform', '')}`")
        lines.append(f"- bucket: `{sample.get('bucket', '')}`")
        lines.append(f"- gap_min: `{sample.get('gap_min', '')}`")
        lines.append("")
        lines.append("```text")
        lines.extend(transcript_lines(sample))
        lines.append("```")
        lines.append("")

    path.write_text("\n".join(lines), encoding="utf-8")


def main():
    parser = argparse.ArgumentParser(description="Create a natural transcript bundle for boundary API trials.")
    parser.add_argument("--input", type=Path, default=Path("data/boundary_samples_api_allowed.jsonl"))
    parser.add_argument("--output-md", type=Path, default=Path(r"C:\Users\a1\Desktop\api-boundary-trial-bundle.md"))
    parser.add_argument("--output-json", type=Path, default=Path(r"C:\Users\a1\Desktop\api-boundary-trial-bundle.json"))
    parser.add_argument("--bucket", action="append", default=[])
    parser.add_argument("--seed", type=int)
    args = parser.parse_args()

    rows = list(iter_jsonl(args.input))
    if not rows:
        raise SystemExit(f"no rows found: {args.input}")

    rng = random.Random(args.seed)
    buckets = args.bucket or DEFAULT_BUCKETS
    samples = choose_samples(rows, buckets, rng)
    if not samples:
        raise SystemExit("no samples selected")

    args.output_md.parent.mkdir(parents=True, exist_ok=True)
    args.output_json.parent.mkdir(parents=True, exist_ok=True)
    write_markdown(args.output_md, samples)
    args.output_json.write_text(json.dumps(make_payload(samples), ensure_ascii=False, indent=2), encoding="utf-8")

    summary = {
        "input": str(args.input),
        "output_md": str(args.output_md),
        "output_json": str(args.output_json),
        "selected": [
            {
                "sample_id": sample.get("sample_id"),
                "platform": sample.get("platform"),
                "bucket": sample.get("bucket"),
                "gap_min": sample.get("gap_min"),
            }
            for sample in samples
        ],
    }
    print(json.dumps(summary, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
