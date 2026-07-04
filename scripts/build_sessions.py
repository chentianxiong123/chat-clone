import argparse
import json
from datetime import datetime
from pathlib import Path


TIME_FORMAT = "%Y-%m-%d %H:%M:%S"


def parse_time(value):
    return datetime.strptime(value, TIME_FORMAT)


def read_messages(path):
    messages = []
    with path.open("r", encoding="utf-8") as f:
        for line_no, line in enumerate(f, 1):
            line = line.strip()
            if not line:
                continue
            try:
                item = json.loads(line)
            except json.JSONDecodeError as exc:
                raise ValueError(f"{path}:{line_no}: invalid json: {exc}") from exc

            if "time" not in item or "sender" not in item:
                raise ValueError(f"{path}:{line_no}: missing required time/sender fields")

            item["_dt"] = parse_time(item["time"])
            item["_source_line"] = line_no
            messages.append(item)

    messages.sort(key=lambda x: (x["_dt"], x["_source_line"]))
    return messages


def clean_for_output(item):
    return {
        key: value
        for key, value in item.items()
        if not key.startswith("_")
    }


def gap_after(messages, index):
    if index + 1 >= len(messages):
        return None
    return int((messages[index + 1]["_dt"] - messages[index]["_dt"]).total_seconds())


def speaker_counts(messages):
    counts = {}
    for item in messages:
        sender = str(item.get("sender", ""))
        counts[sender] = counts.get(sender, 0) + 1
    return counts


def type_counts(messages):
    counts = {}
    for item in messages:
        typ = str(item.get("type", ""))
        counts[typ] = counts.get(typ, 0) + 1
    return counts


def build_sessions(messages, platform, threshold_minutes, marker_minutes):
    threshold_sec = threshold_minutes * 60
    marker_secs = [m * 60 for m in marker_minutes]
    sessions = []
    current = []
    split_gap_sec = None

    for item in messages:
        if current:
            gap_sec = int((item["_dt"] - current[-1]["_dt"]).total_seconds())
            if gap_sec > threshold_sec:
                sessions.append(make_session(
                    platform=platform,
                    index=len(sessions) + 1,
                    messages=current,
                    split_gap_sec=split_gap_sec,
                    marker_secs=marker_secs,
                ))
                current = []
                split_gap_sec = gap_sec
        current.append(item)

    if current:
        sessions.append(make_session(
            platform=platform,
            index=len(sessions) + 1,
            messages=current,
            split_gap_sec=split_gap_sec,
            marker_secs=marker_secs,
        ))

    return sessions


def make_session(platform, index, messages, split_gap_sec, marker_secs):
    start = messages[0]["_dt"]
    end = messages[-1]["_dt"]
    candidate_breaks = []

    for i in range(len(messages) - 1):
        gap_sec = gap_after(messages, i)
        if gap_sec is None:
            continue
        matched = [sec // 60 for sec in marker_secs if gap_sec > sec]
        if not matched:
            continue
        candidate_breaks.append({
            "after_index": i,
            "before_index": i + 1,
            "after_time": messages[i]["time"],
            "before_time": messages[i + 1]["time"],
            "gap_sec": gap_sec,
            "levels_min": matched,
            "left_sender": messages[i].get("sender"),
            "right_sender": messages[i + 1].get("sender"),
        })

    return {
        "platform": platform,
        "session_id": f"{platform}_{index:06d}",
        "start": start.strftime(TIME_FORMAT),
        "end": end.strftime(TIME_FORMAT),
        "duration_sec": int((end - start).total_seconds()),
        "split_gap_before_sec": split_gap_sec,
        "message_count": len(messages),
        "speaker_counts": speaker_counts(messages),
        "type_counts": type_counts(messages),
        "candidate_breaks": candidate_breaks,
        "messages": [clean_for_output(item) for item in messages],
    }


def write_jsonl(path, rows):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="\n") as f:
        for row in rows:
            f.write(json.dumps(row, ensure_ascii=False, separators=(",", ":")) + "\n")


def summarize(sessions):
    message_counts = sorted(s["message_count"] for s in sessions)
    break_count = sum(len(s["candidate_breaks"]) for s in sessions)
    if not message_counts:
        return {"sessions": 0, "candidate_breaks": 0}

    def q(p):
        idx = int((len(message_counts) - 1) * p)
        return message_counts[idx]

    return {
        "sessions": len(sessions),
        "candidate_breaks": break_count,
        "messages": sum(message_counts),
        "message_count_min": message_counts[0],
        "message_count_p50": q(0.50),
        "message_count_p90": q(0.90),
        "message_count_p95": q(0.95),
        "message_count_p99": q(0.99),
        "message_count_max": message_counts[-1],
    }


def main():
    parser = argparse.ArgumentParser(description="Build natural chat sessions from cleaned chat jsonl.")
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--platform", required=True)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--threshold-min", type=int, default=60)
    parser.add_argument("--marker-min", type=int, nargs="*", default=[30, 15])
    parser.add_argument("--summary", type=Path)
    args = parser.parse_args()

    marker_minutes = sorted(set(args.marker_min), reverse=True)
    messages = read_messages(args.input)
    sessions = build_sessions(
        messages=messages,
        platform=args.platform,
        threshold_minutes=args.threshold_min,
        marker_minutes=marker_minutes,
    )
    write_jsonl(args.output, sessions)

    summary = {
        "input": str(args.input),
        "output": str(args.output),
        "platform": args.platform,
        "threshold_min": args.threshold_min,
        "marker_min": marker_minutes,
        **summarize(sessions),
    }
    print(json.dumps(summary, ensure_ascii=False, indent=2))

    if args.summary:
        args.summary.parent.mkdir(parents=True, exist_ok=True)
        args.summary.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
