import argparse
import json
import random
import sqlite3
from datetime import datetime
from pathlib import Path


TIME_FORMAT = "%Y-%m-%d %H:%M:%S"


BUCKETS = [
    ("05_15", 5 * 60, 15 * 60),
    ("15_30", 15 * 60, 30 * 60),
    ("30_60", 30 * 60, 60 * 60),
    ("gt_60", 60 * 60, None),
]


def parse_time(value):
    return datetime.strptime(value, TIME_FORMAT)


def bucket_for_gap(gap_sec):
    for name, low, high in BUCKETS:
        if gap_sec > low and (high is None or gap_sec <= high):
            return name
    return None


def load_messages(conn, platform):
    rows = conn.execute(
        """
        SELECT seq, msg_id, time, speaker_role, msg_type, text
        FROM events
        WHERE platform = ? AND event_type = 'message'
        ORDER BY seq
        """,
        (platform,),
    ).fetchall()
    messages = []
    for row in rows:
        seq, msg_id, time, speaker_role, msg_type, text = row
        messages.append({
            "seq": seq,
            "msg_id": msg_id,
            "time": time,
            "dt": parse_time(time),
            "speaker_role": speaker_role,
            "msg_type": msg_type,
            "text": text,
        })
    return messages


def public_message(message):
    return {
        "time": message["time"],
        "role": message["speaker_role"],
        "type": message["msg_type"],
        "text": message["text"],
    }


def collect_candidates(messages, platform, left_size, right_size):
    candidates = {name: [] for name, _, _ in BUCKETS}
    for i in range(len(messages) - 1):
        left = messages[i]
        right = messages[i + 1]
        gap_sec = int((right["dt"] - left["dt"]).total_seconds())
        bucket = bucket_for_gap(gap_sec)
        if bucket is None:
            continue
        left_messages = messages[max(0, i - left_size + 1):i + 1]
        right_messages = messages[i + 1:i + 1 + right_size]
        candidates[bucket].append({
            "platform": platform,
            "bucket": bucket,
            "gap_sec": gap_sec,
            "gap_min": round(gap_sec / 60, 2),
            "before_msg_id": left["msg_id"],
            "after_msg_id": right["msg_id"],
            "before_time": left["time"],
            "after_time": right["time"],
            "left_messages": [public_message(item) for item in left_messages],
            "right_messages": [public_message(item) for item in right_messages],
            "label": None,
            "notes": "",
        })
    return candidates


def sample_candidates(all_candidates, per_bucket, rng):
    sampled = []
    counts = {}
    for platform, buckets in all_candidates.items():
        for bucket, rows in buckets.items():
            rows = list(rows)
            rng.shuffle(rows)
            chosen = rows[:per_bucket]
            counts[f"{platform}:{bucket}"] = {
                "available": len(rows),
                "sampled": len(chosen),
            }
            for index, row in enumerate(chosen, 1):
                row = dict(row)
                row["sample_id"] = f"{platform}_{bucket}_{index:04d}"
                sampled.append(row)
    sampled.sort(key=lambda row: (row["platform"], row["bucket"], row["sample_id"]))
    return sampled, counts


def write_jsonl(path, rows):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="\n") as f:
        for row in rows:
            f.write(json.dumps(row, ensure_ascii=False, separators=(",", ":")) + "\n")


def format_message(message):
    text = str(message["text"]).replace("\r", " ").replace("\n", " ")
    return f"- {message['time']} [{message['role']}/{message['type']}] {text}"


def write_review_md(path, rows):
    path.parent.mkdir(parents=True, exist_ok=True)
    lines = [
        "# Boundary Review Samples",
        "",
        "标注说明：判断候选间隔处是否应该切成两个自然聊天段。",
        "",
        "- 0 = 不断，同一段",
        "- 1 = 不确定，可断可不断",
        "- 2 = 应断，新一段",
        "",
        "注意：不要判断谁回复谁，只判断两条相邻消息之间是否像自然场景切换。",
        "",
    ]
    for row in rows:
        lines.extend([
            f"## {row['sample_id']}",
            "",
            f"- platform: `{row['platform']}`",
            f"- bucket: `{row['bucket']}`",
            f"- gap: `{row['gap_min']} min`",
            f"- before: `{row['before_msg_id']}` `{row['before_time']}`",
            f"- after: `{row['after_msg_id']}` `{row['after_time']}`",
            "",
            "### 左侧消息",
            "",
        ])
        lines.extend(format_message(item) for item in row["left_messages"])
        lines.extend([
            "",
            f"--- 间隔 {row['gap_min']} 分钟 ---",
            "",
            "### 右侧消息",
            "",
        ])
        lines.extend(format_message(item) for item in row["right_messages"])
        lines.extend([
            "",
            "### 标注",
            "",
            "- [ ] 0 不断",
            "- [ ] 1 不确定",
            "- [ ] 2 应断",
            "",
            "备注：",
            "",
            "---",
            "",
        ])
    path.write_text("\n".join(lines), encoding="utf-8")


def main():
    parser = argparse.ArgumentParser(description="Sample boundary review windows from message event database.")
    parser.add_argument("--db", type=Path, required=True)
    parser.add_argument("--jsonl", type=Path, required=True)
    parser.add_argument("--review-md", type=Path, required=True)
    parser.add_argument("--summary", type=Path)
    parser.add_argument("--per-bucket", type=int, default=20)
    parser.add_argument("--left-size", type=int, default=12)
    parser.add_argument("--right-size", type=int, default=12)
    parser.add_argument("--seed", type=int, default=42)
    args = parser.parse_args()

    rng = random.Random(args.seed)
    conn = sqlite3.connect(args.db)
    try:
        platforms = [
            row[0]
            for row in conn.execute("SELECT DISTINCT platform FROM events ORDER BY platform").fetchall()
        ]
        all_candidates = {}
        for platform in platforms:
            messages = load_messages(conn, platform)
            all_candidates[platform] = collect_candidates(
                messages=messages,
                platform=platform,
                left_size=args.left_size,
                right_size=args.right_size,
            )
    finally:
        conn.close()

    sampled, counts = sample_candidates(all_candidates, args.per_bucket, rng)
    write_jsonl(args.jsonl, sampled)
    write_review_md(args.review_md, sampled)

    summary = {
        "db": str(args.db),
        "jsonl": str(args.jsonl),
        "review_md": str(args.review_md),
        "per_bucket": args.per_bucket,
        "left_size": args.left_size,
        "right_size": args.right_size,
        "seed": args.seed,
        "total_sampled": len(sampled),
        "counts": counts,
    }
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    if args.summary:
        args.summary.parent.mkdir(parents=True, exist_ok=True)
        args.summary.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
