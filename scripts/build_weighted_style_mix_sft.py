import argparse
import hashlib
import json
import random
import re
from collections import Counter, defaultdict
from datetime import datetime
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


def write_jsonl_row(handle, row):
    handle.write(json.dumps(row, ensure_ascii=False, separators=(",", ":")) + "\n")


def clean_text(value):
    text = "" if value is None else str(value)
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    text = CONTROL_CHARS.sub("", text)
    return text.strip()


def parse_dt(value):
    return datetime.strptime(value, "%Y-%m-%d %H:%M:%S")


def stable_hash(value):
    return hashlib.sha256(str(value).encode("utf-8")).hexdigest()[:16]


def platform_from_path(path):
    name = path.name.lower()
    if "qq" in name:
        return "qq"
    if "wx" in name or "wechat" in name:
        return "wechat"
    return path.stem


def is_bad_text(text):
    return not text or URL_RE.search(text) or CODEISH_RE.search(text)


def speaker_label(message, target_sender):
    return "assistant" if message["sender"] == target_sender else "user"


def format_line(message, target_sender, compact):
    label = speaker_label(message, target_sender)
    sep = " " if compact else ": "
    return f"{label}{sep}{message['text']}"


def build_prompt(context, target_sender, compact):
    lines = [
        format_line(message, target_sender, compact)
        for message in context
    ]
    target = "assistant"
    lines.append(target if compact else f"{target}:")
    return "\n".join(lines)


def response_weight(response):
    length = len(response.replace("\n", ""))
    if length <= 4:
        return 3
    if length <= 8:
        return 2
    return 1


def load_messages(input_paths, max_gap_minutes):
    stats = Counter()
    sessions = []

    for path in input_paths:
        platform = platform_from_path(path)
        session = []
        previous_dt = None

        for _, raw in iter_jsonl(path):
            stats["rows_total"] += 1
            if str(raw.get("type", "")) != "text":
                stats["skip_non_text"] += 1
                continue

            text = clean_text(raw.get("text", ""))
            if is_bad_text(text):
                stats["skip_bad_text"] += 1
                continue

            try:
                dt = parse_dt(raw.get("time", ""))
            except Exception:
                stats["skip_bad_time"] += 1
                continue

            if previous_dt is not None:
                gap = (dt - previous_dt).total_seconds()
                if gap < 0 or gap > max_gap_minutes * 60:
                    if session:
                        sessions.append(session)
                    session = []
                    stats["session_break_gap"] += 1

            session.append(
                {
                    "time": raw.get("time", ""),
                    "dt": dt,
                    "sender": str(raw.get("sender", "")),
                    "text": text,
                    "platform": platform,
                }
            )
            previous_dt = dt

        if session:
            sessions.append(session)

    stats["sessions_total"] = len(sessions)
    return sessions, stats


def add_candidate(candidates, kind, prompt, response, platform, stats):
    if not prompt or not response:
        return
    row = {"prompt": prompt, "response": response}
    candidates.append((kind, platform, response, row))
    stats[f"{kind}_candidates"] += 1
    stats[f"{kind}_platform_{platform}"] += 1


def build_candidates(
    sessions,
    target_sender,
    context_messages,
    max_target_chars,
    max_context_chars,
    burst_max_lines,
    burst_max_response_chars,
    compact_prompt,
):
    candidates = []
    stats = Counter()

    for session in sessions:
        for index, message in enumerate(session):
            if message["sender"] != target_sender:
                continue
            if len(message["text"]) > max_target_chars:
                stats["skip_long_single_target"] += 1
                continue

            context = session[max(0, index - context_messages):index]
            if not context:
                stats["skip_empty_context"] += 1
                continue
            if max_context_chars > 0 and sum(len(m["text"]) for m in context) > max_context_chars:
                stats["skip_long_context"] += 1
                continue

            prompt = build_prompt(
                context, target_sender, compact_prompt
            )
            add_candidate(candidates, "single", prompt, message["text"], message["platform"], stats)

        index = 0
        while index < len(session):
            message = session[index]
            if message["sender"] != target_sender:
                index += 1
                continue

            run = []
            j = index
            while j < len(session) and session[j]["sender"] == target_sender:
                text = session[j]["text"]
                if len(text) > max_target_chars:
                    break
                run.append(session[j])
                if len(run) >= burst_max_lines:
                    break
                j += 1

            if len(run) >= 2:
                context = session[max(0, index - context_messages):index]
                response = "\n".join(m["text"] for m in run)
                if context and len(response.replace("\n", "")) <= burst_max_response_chars:
                    if max_context_chars <= 0 or sum(len(m["text"]) for m in context) <= max_context_chars:
                        prompt = build_prompt(
                            context, target_sender, compact_prompt
                        )
                        add_candidate(candidates, "burst", prompt, response, message["platform"], stats)
                    else:
                        stats["skip_long_burst_context"] += 1
                else:
                    stats["skip_bad_burst"] += 1

            index = max(index + 1, j)

    stats["candidates_total"] = len(candidates)
    return candidates, stats


def weighted_select(candidates, max_samples, burst_ratio, response_cap, seed):
    rng = random.Random(seed)
    pools = {"single": [], "burst": []}
    by_response = defaultdict(int)
    stats = Counter()

    shuffled = list(candidates)
    rng.shuffle(shuffled)
    for kind, platform, response, row in shuffled:
        normalized_response = response.strip()
        if response_cap > 0 and by_response[normalized_response] >= response_cap:
            stats["skip_response_cap"] += 1
            continue
        by_response[normalized_response] += 1
        weight = response_weight(response)
        for _ in range(weight):
            pools[kind].append((row, platform, response))
        stats[f"kept_{kind}"] += 1

    rng.shuffle(pools["single"])
    rng.shuffle(pools["burst"])

    if max_samples <= 0:
        selected = pools["single"] + pools["burst"]
        rng.shuffle(selected)
        return selected, stats

    burst_target = int(max_samples * burst_ratio)
    single_target = max_samples - burst_target
    selected = pools["burst"][:burst_target] + pools["single"][:single_target]

    if len(selected) < max_samples:
        used_ids = {id(item) for item in selected}
        rest = [item for item in pools["single"] + pools["burst"] if id(item) not in used_ids]
        selected += rest[: max_samples - len(selected)]

    rng.shuffle(selected)
    return selected[:max_samples], stats


def summarize_lengths(rows):
    response_chars = [len(row["response"].replace("\n", "")) for row, _, _ in rows]
    prompt_chars = [len(row["prompt"]) for row, _, _ in rows]

    def percentile(values, p):
        if not values:
            return None
        values = sorted(values)
        return values[int((len(values) - 1) * p)]

    return {
        "prompt_chars_p50": percentile(prompt_chars, 0.50),
        "prompt_chars_p90": percentile(prompt_chars, 0.90),
        "response_chars_p50": percentile(response_chars, 0.50),
        "response_chars_p90": percentile(response_chars, 0.90),
    }


def write_dataset(rows, output_dir, val_ratio, seed):
    rng = random.Random(seed)
    rows = list(rows)
    rng.shuffle(rows)

    output_dir.mkdir(parents=True, exist_ok=True)
    val_count = int(len(rows) * val_ratio)
    val = rows[:val_count]
    train = rows[val_count:]

    for path, part in [
        (output_dir / "all.jsonl", rows),
        (output_dir / "train.jsonl", train),
        (output_dir / "val.jsonl", val),
    ]:
        with path.open("w", encoding="utf-8", newline="\n") as f:
            for row, _, _ in part:
                write_jsonl_row(f, row)

    return train, val


def main():
    parser = argparse.ArgumentParser(description="Build weighted fast style SFT from cleaned chat records.")
    parser.add_argument("--input", type=Path, nargs="+", required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--target-sender", required=True)
    parser.add_argument("--context-messages", type=int, default=2)
    parser.add_argument("--max-target-chars", type=int, default=8)
    parser.add_argument("--max-context-chars", type=int, default=40)
    parser.add_argument("--max-gap-minutes", type=int, default=15)
    parser.add_argument("--burst-max-lines", type=int, default=4)
    parser.add_argument("--burst-max-response-chars", type=int, default=32)
    parser.add_argument("--burst-ratio", type=float, default=0.5)
    parser.add_argument("--response-cap", type=int, default=300)
    parser.add_argument("--max-samples", type=int, default=10000)
    parser.add_argument("--val-ratio", type=float, default=0.01)
    parser.add_argument("--seed", type=int, default=20260706)
    parser.add_argument("--compact-prompt", action="store_true")
    args = parser.parse_args()

    for path in args.input:
        if not path.exists():
            raise SystemExit(f"input not found: {path}")
    if args.burst_ratio < 0 or args.burst_ratio > 1:
        raise SystemExit("--burst-ratio must be between 0 and 1")

    sessions, load_stats = load_messages(args.input, args.max_gap_minutes)
    candidates, candidate_stats = build_candidates(
        sessions=sessions,
        target_sender=args.target_sender,
        context_messages=args.context_messages,
        max_target_chars=args.max_target_chars,
        max_context_chars=args.max_context_chars,
        burst_max_lines=args.burst_max_lines,
        burst_max_response_chars=args.burst_max_response_chars,
        compact_prompt=args.compact_prompt,
    )
    selected, select_stats = weighted_select(
        candidates=candidates,
        max_samples=args.max_samples,
        burst_ratio=args.burst_ratio,
        response_cap=args.response_cap,
        seed=args.seed,
    )
    train, val = write_dataset(selected, args.output_dir, args.val_ratio, args.seed)

    kind_counts = Counter("burst" if "\n" in row["response"] else "single" for row, _, _ in selected)
    platform_counts = Counter(platform for _, platform, _ in selected)

    summary = {
        "inputs": [str(path) for path in args.input],
        "output_dir": str(args.output_dir),
        "target_sender_hash": stable_hash(args.target_sender),
        "context_messages": args.context_messages,
        "max_target_chars": args.max_target_chars,
        "max_context_chars": args.max_context_chars,
        "max_gap_minutes": args.max_gap_minutes,
        "burst_max_lines": args.burst_max_lines,
        "burst_max_response_chars": args.burst_max_response_chars,
        "burst_ratio": args.burst_ratio,
        "response_cap": args.response_cap,
        "max_samples": args.max_samples,
        "val_ratio": args.val_ratio,
        "seed": args.seed,
        "compact_prompt": args.compact_prompt,
        "samples_total": len(selected),
        "train_samples": len(train),
        "val_samples": len(val),
        "selected_by_kind": dict(kind_counts),
        "selected_by_platform": dict(platform_counts),
        "lengths": summarize_lengths(selected),
        "load_stats": dict(sorted(load_stats.items())),
        "candidate_stats": dict(sorted(candidate_stats.items())),
        "select_stats": dict(sorted(select_stats.items())),
    }
    (args.output_dir / "summary.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    print(json.dumps(summary, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
