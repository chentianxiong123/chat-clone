import argparse
import json
import sqlite3
from datetime import datetime
from pathlib import Path


TIME_FORMAT = "%Y-%m-%d %H:%M:%S"


SCHEMA = """
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;

DROP TABLE IF EXISTS events;
DROP TABLE IF EXISTS meta;

CREATE TABLE meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    platform TEXT NOT NULL,
    seq INTEGER NOT NULL,
    event_uid TEXT NOT NULL UNIQUE,
    event_type TEXT NOT NULL CHECK (event_type IN ('message', 'marker')),

    msg_id TEXT,
    source_line INTEGER,
    time TEXT,
    sender TEXT,
    speaker_role TEXT,
    is_target INTEGER,
    msg_type TEXT,
    text TEXT,

    marker_type TEXT,
    strength TEXT,
    before_msg_id TEXT,
    after_msg_id TEXT,
    before_time TEXT,
    after_time TEXT,
    gap_sec INTEGER,
    levels_min_json TEXT
);

CREATE UNIQUE INDEX idx_events_platform_seq ON events(platform, seq);
CREATE INDEX idx_events_type ON events(event_type);
CREATE INDEX idx_events_msg_id ON events(msg_id);
CREATE INDEX idx_events_marker_strength ON events(strength);
CREATE INDEX idx_events_time ON events(time);
"""


def parse_source(value):
    if "=" not in value:
        raise argparse.ArgumentTypeError("source must be PLATFORM=PATH")
    platform, path = value.split("=", 1)
    platform = platform.strip()
    if not platform:
        raise argparse.ArgumentTypeError("source platform is empty")
    return platform, Path(path)


def parse_time(value):
    return datetime.strptime(value, TIME_FORMAT)


def role_for_sender(sender, target_sender, user_sender):
    if sender == target_sender:
        return "target", 1
    if user_sender and sender == user_sender:
        return "user", 0
    return "other", 0


def read_platform_messages(path):
    rows = []
    with path.open("r", encoding="utf-8") as f:
        for source_line, line in enumerate(f, 1):
            line = line.strip()
            if not line:
                continue
            obj = json.loads(line)
            if "time" not in obj or "sender" not in obj:
                raise ValueError(f"{path}:{source_line}: missing time or sender")
            obj["_dt"] = parse_time(obj["time"])
            obj["_source_line"] = source_line
            rows.append(obj)
    rows.sort(key=lambda item: (item["_dt"], item["_source_line"]))
    return rows


def marker_levels(gap_sec, thresholds_min):
    return [minutes for minutes in thresholds_min if gap_sec > minutes * 60]


def marker_strength(levels):
    if 60 in levels:
        return "hard_break"
    return "candidate"


def insert_meta(conn, data):
    conn.executemany(
        "INSERT INTO meta(key, value) VALUES (?, ?)",
        [(key, json.dumps(value, ensure_ascii=False)) for key, value in data.items()],
    )


def insert_event(conn, event):
    conn.execute(
        """
        INSERT INTO events(
            platform, seq, event_uid, event_type,
            msg_id, source_line, time, sender, speaker_role, is_target, msg_type, text,
            marker_type, strength, before_msg_id, after_msg_id, before_time, after_time,
            gap_sec, levels_min_json
        )
        VALUES (
            :platform, :seq, :event_uid, :event_type,
            :msg_id, :source_line, :time, :sender, :speaker_role, :is_target, :msg_type, :text,
            :marker_type, :strength, :before_msg_id, :after_msg_id, :before_time, :after_time,
            :gap_sec, :levels_min_json
        )
        """,
        event,
    )


def empty_event(platform, seq, event_type):
    return {
        "platform": platform,
        "seq": seq,
        "event_uid": f"{platform}_e{seq:08d}",
        "event_type": event_type,
        "msg_id": None,
        "source_line": None,
        "time": None,
        "sender": None,
        "speaker_role": None,
        "is_target": None,
        "msg_type": None,
        "text": None,
        "marker_type": None,
        "strength": None,
        "before_msg_id": None,
        "after_msg_id": None,
        "before_time": None,
        "after_time": None,
        "gap_sec": None,
        "levels_min_json": None,
    }


def build_events_for_platform(conn, platform, path, target_sender, user_sender, thresholds_min):
    messages = read_platform_messages(path)
    seq = 0
    msg_index = 0
    prev = None
    prev_msg_id = None
    stats = {
        "messages": 0,
        "markers": 0,
        "hard_breaks": 0,
        "candidate_breaks": 0,
        "by_level": {str(minutes): 0 for minutes in thresholds_min},
    }

    for obj in messages:
        msg_index += 1
        msg_id = f"{platform}_m{msg_index:08d}"

        if prev is not None:
            gap_sec = int((obj["_dt"] - prev["_dt"]).total_seconds())
            levels = marker_levels(gap_sec, thresholds_min)
            if levels:
                seq += 1
                marker = empty_event(platform, seq, "marker")
                strength = marker_strength(levels)
                marker.update({
                    "marker_type": "time_gap",
                    "strength": strength,
                    "before_msg_id": prev_msg_id,
                    "after_msg_id": msg_id,
                    "before_time": prev["time"],
                    "after_time": obj["time"],
                    "gap_sec": gap_sec,
                    "levels_min_json": json.dumps(levels, ensure_ascii=False, separators=(",", ":")),
                })
                insert_event(conn, marker)
                stats["markers"] += 1
                if strength == "hard_break":
                    stats["hard_breaks"] += 1
                else:
                    stats["candidate_breaks"] += 1
                for minutes in levels:
                    stats["by_level"][str(minutes)] += 1

        sender = str(obj.get("sender", ""))
        speaker_role, is_target = role_for_sender(sender, target_sender, user_sender)

        seq += 1
        event = empty_event(platform, seq, "message")
        event.update({
            "msg_id": msg_id,
            "source_line": obj["_source_line"],
            "time": obj["time"],
            "sender": sender,
            "speaker_role": speaker_role,
            "is_target": is_target,
            "msg_type": str(obj.get("type", "")),
            "text": str(obj.get("text", "")),
        })
        insert_event(conn, event)
        stats["messages"] += 1

        prev = obj
        prev_msg_id = msg_id

    stats["events"] = seq
    stats["input"] = str(path)
    return stats


def summarize_database(conn):
    summary = {}
    for platform, count in conn.execute("SELECT platform, COUNT(*) FROM events GROUP BY platform"):
        summary.setdefault(platform, {})["events"] = count
    for platform, event_type, count in conn.execute(
        "SELECT platform, event_type, COUNT(*) FROM events GROUP BY platform, event_type"
    ):
        summary.setdefault(platform, {})[event_type] = count
    for platform, strength, count in conn.execute(
        "SELECT platform, strength, COUNT(*) FROM events WHERE event_type='marker' GROUP BY platform, strength"
    ):
        summary.setdefault(platform, {}).setdefault("markers_by_strength", {})[strength] = count
    return summary


def main():
    parser = argparse.ArgumentParser(description="Build an interpolated message event stream SQLite database.")
    parser.add_argument("--source", action="append", type=parse_source, required=True, help="PLATFORM=PATH")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--summary", type=Path)
    parser.add_argument("--target-sender", required=True)
    parser.add_argument("--user-sender", default="")
    parser.add_argument("--threshold-min", type=int, nargs="+", default=[60, 30, 15])
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args()

    thresholds_min = sorted(set(args.threshold_min), reverse=True)
    if args.output.exists():
        if not args.force:
            raise SystemExit(f"output already exists: {args.output} (use --force to overwrite)")
        args.output.unlink()

    args.output.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(args.output)
    try:
        conn.executescript(SCHEMA)
        source_stats = {}
        with conn:
            insert_meta(conn, {
                "threshold_min": thresholds_min,
                "sources": {platform: str(path) for platform, path in args.source},
                "target_sender": args.target_sender,
                "user_sender": args.user_sender,
            })
            for platform, path in args.source:
                source_stats[platform] = build_events_for_platform(
                    conn=conn,
                    platform=platform,
                    path=path,
                    target_sender=args.target_sender,
                    user_sender=args.user_sender,
                    thresholds_min=thresholds_min,
                )
        summary = {
            "output": str(args.output),
            "threshold_min": thresholds_min,
            "source_stats": source_stats,
            "database_summary": summarize_database(conn),
        }
    finally:
        conn.close()

    print(json.dumps(summary, ensure_ascii=False, indent=2))
    if args.summary:
        args.summary.parent.mkdir(parents=True, exist_ok=True)
        args.summary.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
