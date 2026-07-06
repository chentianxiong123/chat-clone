import argparse
import json
import random
import re
from pathlib import Path


SESSION_ID_RE = re.compile(r"_(\d+)$")


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


def session_number(session_id):
    match = SESSION_ID_RE.search(str(session_id))
    if not match:
        return None
    return int(match.group(1))


def load_routed_sessions(allowed_path, blocked_path):
    rows = []
    for route_path in (allowed_path, blocked_path):
        for row in iter_jsonl(route_path):
            number = session_number(row.get("session_id"))
            if number is None:
                continue
            row["_session_number"] = number
            rows.append(row)
    rows.sort(key=lambda item: item["_session_number"])
    return rows


def clean_text(value):
    return str(value).replace("\r", " ").replace("\n", " ").strip()


def sender_label(session, message):
    sender = str(message.get("sender", ""))
    speakers = list(session.get("speaker_counts", {}).keys())
    if len(speakers) >= 2:
        if sender == speakers[0]:
            return "A"
        if sender == speakers[1]:
            return "B"
    return "A" if sender else "unknown"


def format_message(session, message):
    time = clean_text(message.get("time", ""))
    role = sender_label(session, message)
    text = clean_text(message.get("text", ""))
    return f"[{time}] {role}: {text}"


def segment_excerpt(session, position, window):
    messages = session.get("messages", [])
    if position == "tail":
        selected = messages[-window:]
        prefix = omitted_line(session, len(messages) - len(selected)) if len(messages) > len(selected) else None
        return ([prefix] if prefix else []) + [format_message(session, msg) for msg in selected]

    if position == "head":
        selected = messages[:window]
        suffix = omitted_line(session, len(messages) - len(selected)) if len(messages) > len(selected) else None
        return [format_message(session, msg) for msg in selected] + ([suffix] if suffix else [])

    if position == "both":
        if len(messages) <= window * 2 + 4:
            return [format_message(session, msg) for msg in messages]
        head = messages[:window]
        tail = messages[-window:]
        omitted = len(messages) - len(head) - len(tail)
        return (
            [format_message(session, msg) for msg in head]
            + [omitted_line(session, omitted)]
            + [format_message(session, msg) for msg in tail]
        )

    raise ValueError(f"unknown position: {position}")


def omitted_line(session, omitted_count):
    return (
        f"... 省略 {omitted_count} 条，"
        f"session_id={session.get('session_id')}, "
        f"start={session.get('start')}, end={session.get('end')} ..."
    )


def gap_between(left, right):
    return int(right.get("split_gap_before_sec") or 0)


def gap_line(boundary_id, left, right):
    gap_sec = gap_between(left, right)
    gap_min = round(gap_sec / 60, 2) if gap_sec else None
    return (
        f"--- 候选切分点 {boundary_id}: "
        f"{left.get('session_id')} -> {right.get('session_id')}; "
        f"gap_min={gap_min}; "
        "请判断这里切开是否适合训练分段 ---"
    )


def route_of(session):
    return session.get("api_review", {}).get("route", "unknown")


def review_status_of(session):
    return session.get("api_review", {}).get("review_status", "")


def choose_triplet(rows, rng, require_all_allowed, min_gap_sec=None, max_gap_sec=None):
    by_number = {row["_session_number"]: row for row in rows}
    candidates = []
    for number, current in by_number.items():
        prev_session = by_number.get(number - 1)
        next_session = by_number.get(number + 1)
        if not prev_session or not next_session:
            continue
        triplet = [prev_session, current, next_session]
        if require_all_allowed and any(route_of(session) != "api_allowed" for session in triplet):
            continue
        gaps = [gap_between(prev_session, current), gap_between(current, next_session)]
        if min_gap_sec is not None and any(gap < min_gap_sec for gap in gaps):
            continue
        if max_gap_sec is not None and any(gap > max_gap_sec for gap in gaps):
            continue
        candidates.append(triplet)

    if not candidates:
        return None
    return rng.choice(candidates)


def transcript_for_triplet(triplet, window):
    prev_session, current, next_session = triplet
    lines = []
    lines.append(f"### 前一段 {prev_session.get('session_id')} ({route_of(prev_session)})")
    lines.extend(segment_excerpt(prev_session, "tail", window))
    lines.append("")
    lines.append(gap_line("A", prev_session, current))
    lines.append("")
    lines.append(f"### 当前段 {current.get('session_id')} ({route_of(current)})")
    lines.extend(segment_excerpt(current, "both", window))
    lines.append("")
    lines.append(gap_line("B", current, next_session))
    lines.append("")
    lines.append(f"### 后一段 {next_session.get('session_id')} ({route_of(next_session)})")
    lines.extend(segment_excerpt(next_session, "head", window))
    return lines


def payload(triplet, window):
    prev_session, current, next_session = triplet
    return {
        "task": "判断两个相邻 session 边界是否适合切开，用于后续训练上下文分段。",
        "decision_rule": "重点看候选切分点前后相邻消息。前一段末尾、当前段开头/末尾、后一段开头只作为必要上下文。不要总结原文，不要改写原文。",
        "output_only_json": True,
        "output_schema": [
            {
                "boundary_id": "A | B",
                "left_session_id": "string",
                "right_session_id": "string",
                "cut": "cut_ok | not_cut",
                "confidence": "0.0-1.0",
                "reason": "不超过30字，只说明判断依据，不引用原文"
            }
        ],
        "segments": [
            segment_meta(prev_session),
            segment_meta(current),
            segment_meta(next_session),
        ],
        "boundaries": [
            boundary_meta("A", prev_session, current),
            boundary_meta("B", current, next_session),
        ],
        "transcript": "\n".join(transcript_for_triplet(triplet, window)),
    }


def segment_meta(session):
    return {
        "session_id": session.get("session_id"),
        "start": session.get("start"),
        "end": session.get("end"),
        "message_count": session.get("message_count"),
        "api_route": route_of(session),
        "review_status": review_status_of(session),
    }


def boundary_meta(boundary_id, left, right):
    gap_sec = gap_between(left, right)
    return {
        "boundary_id": boundary_id,
        "left_session_id": left.get("session_id"),
        "right_session_id": right.get("session_id"),
        "gap_sec": gap_sec,
        "gap_min": round(gap_sec / 60, 2) if gap_sec else None,
    }


def write_markdown(path, triplet, platform, threshold_min, window):
    lines = []
    lines.append("# 外援 API 相邻三段边界试水样本")
    lines.append("")
    lines.append(f"平台：`{platform}`")
    lines.append(f"session 阈值：`{threshold_min}m`")
    lines.append("")
    lines.append("任务：判断两个候选切分点是否适合切开，用于后续训练上下文分段。")
    lines.append("")
    lines.append("重点：只看候选切分点前后相邻消息。不要总结原文，不要改写原文。")
    lines.append("")
    lines.append("只输出 JSON：")
    lines.append("")
    lines.append("```json")
    lines.append("[")
    lines.append("  {")
    lines.append('    "boundary_id": "A",')
    lines.append('    "left_session_id": "...",')
    lines.append('    "right_session_id": "...",')
    lines.append('    "cut": "cut_ok | not_cut",')
    lines.append('    "confidence": 0.0,')
    lines.append('    "reason": "不超过30字，只说明判断依据，不引用原文"')
    lines.append("  }")
    lines.append("]")
    lines.append("```")
    lines.append("")
    lines.append("```text")
    lines.extend(transcript_for_triplet(triplet, window))
    lines.append("```")
    lines.append("")
    path.write_text("\n".join(lines), encoding="utf-8")


def main():
    parser = argparse.ArgumentParser(description="Create a trial bundle with three adjacent routed sessions.")
    parser.add_argument("--platform", default="wechat")
    parser.add_argument("--threshold-min", type=int, default=30)
    parser.add_argument("--input-dir", type=Path, default=Path("data/api_segments"))
    parser.add_argument("--output-md", type=Path, default=Path("workspace/docs_exports/api-adjacent-segment-trial.md"))
    parser.add_argument("--output-json", type=Path, default=Path("workspace/docs_exports/api-adjacent-segment-trial.json"))
    parser.add_argument("--window", type=int, default=12)
    parser.add_argument("--seed", type=int)
    parser.add_argument("--allow-manual-review", action="store_true")
    parser.add_argument("--min-gap-min", type=float)
    parser.add_argument("--max-gap-min", type=float)
    args = parser.parse_args()

    stem = f"sessions_{args.platform}_{args.threshold_min}m"
    allowed_path = args.input_dir / f"{stem}_api_allowed.jsonl"
    blocked_path = args.input_dir / f"{stem}_api_blocked.jsonl"
    rows = load_routed_sessions(allowed_path, blocked_path)
    if not rows:
        raise SystemExit(f"no routed sessions found for {stem}")

    rng = random.Random(args.seed)
    min_gap_sec = int(args.min_gap_min * 60) if args.min_gap_min is not None else None
    max_gap_sec = int(args.max_gap_min * 60) if args.max_gap_min is not None else None
    triplet = choose_triplet(
        rows,
        rng,
        require_all_allowed=not args.allow_manual_review,
        min_gap_sec=min_gap_sec,
        max_gap_sec=max_gap_sec,
    )
    if not triplet:
        raise SystemExit("no adjacent triplet matched the route constraint")

    args.output_md.parent.mkdir(parents=True, exist_ok=True)
    args.output_json.parent.mkdir(parents=True, exist_ok=True)
    write_markdown(args.output_md, triplet, args.platform, args.threshold_min, args.window)
    args.output_json.write_text(
        json.dumps(payload(triplet, args.window), ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

    summary = {
        "platform": args.platform,
        "threshold_min": args.threshold_min,
        "output_md": str(args.output_md),
        "output_json": str(args.output_json),
        "segments": [segment_meta(session) for session in triplet],
        "boundaries": [
            boundary_meta("A", triplet[0], triplet[1]),
            boundary_meta("B", triplet[1], triplet[2]),
        ],
    }
    print(json.dumps(summary, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
