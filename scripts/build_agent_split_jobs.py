import argparse
import json
from collections import Counter, defaultdict
from datetime import datetime
from pathlib import Path


TIME_FORMAT = "%Y-%m-%d %H:%M:%S"


DEFAULT_SOURCES = [
    ("wechat", "api_allowed", Path("data/api_segments/sessions_wechat_60m_api_allowed.jsonl")),
    ("qq", "api_allowed", Path("data/api_segments/sessions_qq_60m_api_allowed.jsonl")),
    ("wechat", "manual_review", Path("data/api_segments/sessions_wechat_60m_api_blocked.jsonl")),
    ("qq", "manual_review", Path("data/api_segments/sessions_qq_60m_api_blocked.jsonl")),
]


PROMPT_TEXT = """# Agent 大段细分任务说明

你会收到一条 JSON job。它是一段按 60 分钟硬切出来的大容器聊天记录。

目标：只判断这段内部哪些相邻消息之间适合切开，用于后续生成训练小段。

要求：

1. 不改写原文。
2. 不总结原文。
3. 不合并消息。
4. 不把聊天理解成一问一答。
5. 切分单位只能是相邻两条消息之间。
6. 优先评估 `candidate_boundaries`，必要时可以补充极少量明显切点。
7. 如果不确定，默认 `keep`。
8. `reason` 不要引用原文，最多 30 个字。

判断标准：

```text
从这里切开后，右侧片段是否仍能作为独立训练上下文继续使用。
```

输出严格 JSON：

```json
{
  "job_id": "string",
  "decisions": [
    {
      "boundary_id": "string",
      "decision": "cut | keep | uncertain",
      "confidence": 0.0,
      "reason": "不超过30字，不引用原文"
    }
  ],
  "extra_cuts": [
    {
      "left_message_index": 0,
      "right_message_index": 1,
      "confidence": 0.0,
      "reason": "不超过30字，不引用原文"
    }
  ]
}
```

说明：

- `messages[i].i` 是稳定消息下标。
- 一个切点必须满足：`right_message_index = left_message_index + 1`。
- `api_allowed` job 才能给外援 API。
- `manual_review` job 只能人工或本地处理。
"""


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


def parse_time(value):
    return datetime.strptime(value, TIME_FORMAT)


def gap_bucket(gap_sec):
    if gap_sec is None:
        return None
    if gap_sec > 60 * 60:
        return "gt_60"
    if gap_sec > 30 * 60:
        return "30_60"
    if gap_sec > 15 * 60:
        return "15_30"
    if gap_sec > 5 * 60:
        return "05_15"
    return "lte_05"


def collect_speaker_counts(sources):
    counts_by_platform = defaultdict(Counter)
    for platform, _, path in sources:
        if not path.exists():
            continue
        for _, session in iter_jsonl(path):
            for sender, count in session.get("speaker_counts", {}).items():
                counts_by_platform[platform][str(sender)] += int(count)
    return counts_by_platform


def make_role_maps(counts_by_platform):
    role_maps = {}
    for platform, counts in counts_by_platform.items():
        role_maps[platform] = {
            sender: f"speaker_{idx + 1}"
            for idx, (sender, _) in enumerate(counts.most_common())
        }
    return role_maps


def role_for_sender(platform, sender, role_maps):
    role = role_maps.get(platform, {}).get(str(sender))
    if role:
        return role
    return "speaker_other"


def build_messages(session, platform, role_maps):
    messages = []
    previous_dt = None
    for index, message in enumerate(session.get("messages", [])):
        dt = parse_time(message["time"])
        delta_prev_sec = None if previous_dt is None else int((dt - previous_dt).total_seconds())
        previous_dt = dt
        messages.append({
            "i": index,
            "time": message.get("time"),
            "delta_prev_sec": delta_prev_sec,
            "speaker": role_for_sender(platform, message.get("sender", ""), role_maps),
            "type": str(message.get("type", "")),
            "text": str(message.get("text", "")),
        })
    return messages


def build_candidate_boundaries(session, platform, role_maps):
    boundaries = []
    for idx, item in enumerate(session.get("candidate_breaks", []), 1):
        left_index = int(item["after_index"])
        right_index = int(item["before_index"])
        gap_sec = int(item["gap_sec"])
        boundaries.append({
            "boundary_id": f"{session.get('session_id')}_b{idx:04d}",
            "left_message_index": left_index,
            "right_message_index": right_index,
            "left_time": item.get("after_time"),
            "right_time": item.get("before_time"),
            "gap_sec": gap_sec,
            "gap_min": round(gap_sec / 60, 2),
            "bucket": gap_bucket(gap_sec),
            "levels_min": item.get("levels_min", []),
            "left_speaker": role_for_sender(platform, item.get("left_sender", ""), role_maps),
            "right_speaker": role_for_sender(platform, item.get("right_sender", ""), role_maps),
        })
    return boundaries


def build_job(session, platform, route, threshold_min, source_path, role_maps):
    session_id = session.get("session_id")
    messages = build_messages(session, platform, role_maps)
    candidates = build_candidate_boundaries(session, platform, role_maps)
    review_status = "external_api_ok" if route == "api_allowed" else "manual_review_required"
    return {
        "schema_version": 1,
        "job_id": f"{session_id}_split60_job",
        "task": "split_large_chat_segment",
        "route": route,
        "review_status": review_status,
        "source": {
            "source_file": str(source_path),
            "platform": platform,
            "session_id": session_id,
            "threshold_min": threshold_min,
        },
        "container": {
            "start": session.get("start"),
            "end": session.get("end"),
            "duration_sec": session.get("duration_sec"),
            "split_gap_before_sec": session.get("split_gap_before_sec"),
            "message_count": session.get("message_count"),
            "candidate_boundary_count": len(candidates),
        },
        "api_review": session.get("api_review", {
            "route": "api_allowed" if route == "api_allowed" else "api_blocked",
        }),
        "messages": messages,
        "candidate_boundaries": candidates,
    }


def write_jsonl_row(handle, row):
    handle.write(json.dumps(row, ensure_ascii=False, separators=(",", ":")) + "\n")


def percentile(sorted_values, p):
    if not sorted_values:
        return None
    index = int((len(sorted_values) - 1) * p)
    return sorted_values[index]


def summarize_jobs(stats, message_counts):
    sorted_counts = sorted(message_counts)
    summary = {
        "jobs_total": stats["jobs_total"],
        "messages_total": stats["messages_total"],
        "candidate_boundaries_total": stats["candidate_boundaries_total"],
        "routes": dict(stats["routes"]),
        "platforms": {
            platform: dict(counter)
            for platform, counter in sorted(stats["platforms"].items())
        },
        "message_count": {
            "min": sorted_counts[0] if sorted_counts else None,
            "p50": percentile(sorted_counts, 0.50),
            "p90": percentile(sorted_counts, 0.90),
            "p95": percentile(sorted_counts, 0.95),
            "p99": percentile(sorted_counts, 0.99),
            "max": sorted_counts[-1] if sorted_counts else None,
        },
        "candidate_boundary_buckets": dict(stats["candidate_boundary_buckets"]),
    }
    return summary


def build_jobs(sources, threshold_min, output_dir, prompt_output):
    output_dir.mkdir(parents=True, exist_ok=True)
    if prompt_output:
        prompt_output.parent.mkdir(parents=True, exist_ok=True)
        prompt_output.write_text(PROMPT_TEXT, encoding="utf-8")

    counts_by_platform = collect_speaker_counts(sources)
    role_maps = make_role_maps(counts_by_platform)

    output_paths = {
        "api_allowed": output_dir / "large_segments_60m_api_allowed.jsonl",
        "manual_review": output_dir / "large_segments_60m_manual_review.jsonl",
    }
    handles = {
        route: path.open("w", encoding="utf-8", newline="\n")
        for route, path in output_paths.items()
    }

    stats = {
        "jobs_total": 0,
        "messages_total": 0,
        "candidate_boundaries_total": 0,
        "routes": Counter(),
        "platforms": defaultdict(Counter),
        "candidate_boundary_buckets": Counter(),
    }
    message_counts = []

    try:
        for platform, route, path in sources:
            if not path.exists():
                raise FileNotFoundError(path)
            for _, session in iter_jsonl(path):
                job = build_job(
                    session=session,
                    platform=platform,
                    route=route,
                    threshold_min=threshold_min,
                    source_path=path,
                    role_maps=role_maps,
                )
                write_jsonl_row(handles[route], job)

                message_count = int(job["container"]["message_count"] or len(job["messages"]))
                candidate_count = int(job["container"]["candidate_boundary_count"])
                stats["jobs_total"] += 1
                stats["messages_total"] += message_count
                stats["candidate_boundaries_total"] += candidate_count
                stats["routes"][route] += 1
                stats["platforms"][platform][route] += 1
                message_counts.append(message_count)
                for boundary in job["candidate_boundaries"]:
                    stats["candidate_boundary_buckets"][boundary["bucket"]] += 1
    finally:
        for handle in handles.values():
            handle.close()

    summary = summarize_jobs(stats, message_counts)
    summary.update({
        "threshold_min": threshold_min,
        "outputs": {route: str(path) for route, path in output_paths.items()},
        "prompt_output": str(prompt_output) if prompt_output else None,
        "sources": [
            {"platform": platform, "route": route, "path": str(path)}
            for platform, route, path in sources
        ],
        "speaker_roles": {
            platform: {
                "role_count": len(role_map),
                "roles": sorted(set(role_map.values()), key=lambda value: int(value.split("_")[-1])),
            }
            for platform, role_map in sorted(role_maps.items())
        },
    })

    summary_path = output_dir / "large_segments_60m.summary.json"
    summary_path.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=False, indent=2))


def parse_source(value):
    parts = value.split("=", 2)
    if len(parts) != 3:
        raise argparse.ArgumentTypeError("source must be PLATFORM=ROUTE=PATH")
    platform, route, path = parts
    if route not in {"api_allowed", "manual_review"}:
        raise argparse.ArgumentTypeError("route must be api_allowed or manual_review")
    return platform, route, Path(path)


def main():
    parser = argparse.ArgumentParser(description="Build 60m large-segment jobs for agent-based splitting.")
    parser.add_argument("--source", action="append", type=parse_source)
    parser.add_argument("--threshold-min", type=int, default=60)
    parser.add_argument("--output-dir", type=Path, default=Path("data/agent_split_jobs"))
    parser.add_argument(
        "--prompt-output",
        type=Path,
        default=Path(r"C:\Users\a1\Desktop\agent-large-segment-split-prompt.md"),
    )
    args = parser.parse_args()

    sources = args.source or DEFAULT_SOURCES
    build_jobs(
        sources=sources,
        threshold_min=args.threshold_min,
        output_dir=args.output_dir,
        prompt_output=args.prompt_output,
    )


if __name__ == "__main__":
    main()
