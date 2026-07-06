import argparse
import hashlib
import json
import random
import re
from collections import Counter
from pathlib import Path


DEFAULT_INPUT = Path("workspace/final_segments/final_segments_v1_allowed.jsonl")
DEFAULT_OUTPUT = Path("workspace/train_sets/train_sft_v1_allowed.jsonl")
DEFAULT_SUMMARY = Path("workspace/train_sets/train_sft_v1_allowed.summary.json")

SYSTEM_PROMPT = "根据聊天上下文，只输出T的下一条消息。"


CONTROL_CHARS = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f]")


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


def format_non_text(message):
    typ = str(message.get("type", "") or "unknown").strip() or "unknown"
    text = clean_text(message.get("text", ""))
    if text:
        return text
    return f"[{typ}]"


def speaker_label(sender, target_sender, other_labels, name_mode):
    sender = str(sender)
    if name_mode == "short":
        if sender == target_sender:
            return "T"
        if sender not in other_labels:
            other_labels[sender] = "U" if not other_labels else f"U{len(other_labels) + 1}"
        return other_labels[sender]
    if name_mode == "original":
        return sender
    if sender == target_sender:
        return "目标人物"
    if sender not in other_labels:
        other_labels[sender] = "对方" if not other_labels else f"对方{len(other_labels) + 1}"
    return other_labels[sender]


def format_message_line(message, target_sender, other_labels, name_mode, include_time):
    label = speaker_label(message.get("sender", ""), target_sender, other_labels, name_mode)
    content = clean_text(message.get("text", ""))
    if str(message.get("type", "")) != "text":
        content = format_non_text(message)
    if include_time:
        return f"[{message.get('time', '')}] {label}: {content}"
    return f"{label}: {content}"


def build_training_row(context_messages, target_message, target_sender, name_mode, include_time, system_prompt):
    other_labels = {}
    context_lines = [
        format_message_line(
            message=message,
            target_sender=target_sender,
            other_labels=other_labels,
            name_mode=name_mode,
            include_time=include_time,
        )
        for message in context_messages
    ]
    target_text = clean_text(target_message.get("text", ""))
    return {
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": "\n".join(context_lines)},
            {"role": "assistant", "content": target_text},
        ]
    }


def should_keep_by_sample_rate(sample_rate, rng):
    if sample_rate >= 1:
        return True
    if sample_rate <= 0:
        return False
    return rng.random() < sample_rate


def stable_hash(value):
    return hashlib.sha256(str(value).encode("utf-8")).hexdigest()[:16]


def build_sft(
    input_path,
    output_path,
    summary_path,
    target_sender,
    context_messages,
    min_context_messages,
    max_target_chars,
    name_mode,
    include_time,
    system_prompt,
    sample_rate,
    seed,
    max_samples,
):
    rng = random.Random(seed)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    if summary_path:
        summary_path.parent.mkdir(parents=True, exist_ok=True)

    stats = Counter()
    context_lengths = []
    target_lengths = []

    with output_path.open("w", encoding="utf-8", newline="\n") as f:
        for _, segment in iter_jsonl(input_path):
            messages = segment.get("messages", [])
            for index, message in enumerate(messages):
                if str(message.get("sender", "")) != target_sender:
                    stats["skip_not_target_sender"] += 1
                    continue
                if str(message.get("type", "")) != "text":
                    stats["skip_non_text_target"] += 1
                    continue

                target_text = clean_text(message.get("text", ""))
                if not target_text:
                    stats["skip_empty_target"] += 1
                    continue
                if max_target_chars > 0 and len(target_text) > max_target_chars:
                    stats["skip_long_target"] += 1
                    continue

                start = max(0, index - context_messages)
                context = messages[start:index]
                if len(context) < min_context_messages:
                    stats["skip_short_context"] += 1
                    continue
                if not should_keep_by_sample_rate(sample_rate, rng):
                    stats["skip_sample_rate"] += 1
                    continue

                row = build_training_row(
                    context_messages=context,
                    target_message=message,
                    target_sender=target_sender,
                    name_mode=name_mode,
                    include_time=include_time,
                    system_prompt=system_prompt,
                )
                write_jsonl_row(f, row)
                stats["samples_total"] += 1
                stats[f"samples_platform_{segment.get('platform', 'unknown')}"] += 1
                context_lengths.append(len(context))
                target_lengths.append(len(target_text))

                if max_samples and stats["samples_total"] >= max_samples:
                    break
            if max_samples and stats["samples_total"] >= max_samples:
                break

    def percentile(values, p):
        if not values:
            return None
        sorted_values = sorted(values)
        index = int((len(sorted_values) - 1) * p)
        return sorted_values[index]

    summary = {
        "input": str(input_path),
        "output": str(output_path),
        "target_sender_hash": stable_hash(target_sender),
        "context_messages": context_messages,
        "min_context_messages": min_context_messages,
        "max_target_chars": max_target_chars,
        "name_mode": name_mode,
        "include_time": include_time,
        "sample_rate": sample_rate,
        "seed": seed,
        "max_samples": max_samples,
        "samples_total": stats["samples_total"],
        "skips": {
            key: value
            for key, value in sorted(stats.items())
            if key.startswith("skip_")
        },
        "samples_by_platform": {
            key.removeprefix("samples_platform_"): value
            for key, value in sorted(stats.items())
            if key.startswith("samples_platform_")
        },
        "context_length": {
            "p50": percentile(context_lengths, 0.50),
            "p90": percentile(context_lengths, 0.90),
            "max": max(context_lengths) if context_lengths else None,
        },
        "target_chars": {
            "p50": percentile(target_lengths, 0.50),
            "p90": percentile(target_lengths, 0.90),
            "max": max(target_lengths) if target_lengths else None,
        },
    }

    if summary_path:
        summary_path.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=False, indent=2))


def main():
    parser = argparse.ArgumentParser(description="Build next-message SFT JSONL from final chat segments.")
    parser.add_argument("--input", type=Path, default=DEFAULT_INPUT)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--summary", type=Path, default=DEFAULT_SUMMARY)
    parser.add_argument("--target-sender", required=True, help="Exact sender value to imitate.")
    parser.add_argument("--context-messages", type=int, default=12)
    parser.add_argument("--min-context-messages", type=int, default=4)
    parser.add_argument("--max-target-chars", type=int, default=1000, help="Use 0 to disable.")
    parser.add_argument("--name-mode", choices=["short", "role", "original"], default="short")
    parser.add_argument("--no-time", action="store_true")
    parser.add_argument("--system-prompt", default=SYSTEM_PROMPT)
    parser.add_argument("--sample-rate", type=float, default=1.0)
    parser.add_argument("--seed", type=int, default=20260705)
    parser.add_argument("--max-samples", type=int, default=0)
    args = parser.parse_args()

    if args.context_messages < 1:
        raise SystemExit("--context-messages must be >= 1")
    if args.min_context_messages < 0:
        raise SystemExit("--min-context-messages must be >= 0")
    if args.sample_rate < 0 or args.sample_rate > 1:
        raise SystemExit("--sample-rate must be between 0 and 1")

    build_sft(
        input_path=args.input,
        output_path=args.output,
        summary_path=args.summary,
        target_sender=args.target_sender,
        context_messages=args.context_messages,
        min_context_messages=args.min_context_messages,
        max_target_chars=args.max_target_chars,
        name_mode=args.name_mode,
        include_time=not args.no_time,
        system_prompt=args.system_prompt,
        sample_rate=args.sample_rate,
        seed=args.seed,
        max_samples=args.max_samples,
    )


if __name__ == "__main__":
    main()
