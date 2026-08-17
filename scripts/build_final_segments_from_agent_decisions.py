import argparse
import json
from collections import Counter
from pathlib import Path


DEFAULT_SESSION_SOURCES = [
    Path("workspace/02_policy_route_sensitive_split/api_segments/sessions_wechat_60m_api_allowed.jsonl"),
    Path("workspace/02_policy_route_sensitive_split/api_segments/sessions_qq_60m_api_allowed.jsonl"),
]
DEFAULT_JOBS = Path("workspace/03_agent_split_jobs/agent_jobs/large_segments_60m_api_allowed.jsonl")
DEFAULT_DECISIONS = Path(
    "workspace/05_agent_decisions/agent_decisions/large_segments_60m_api_allowed.decisions.normalized.jsonl"
)
DEFAULT_OUTPUT = Path("workspace/06_final_segments/final_segments/final_segments_v1_allowed.jsonl")
DEFAULT_SUMMARY = Path("workspace/06_final_segments/final_segments/final_segments_v1_allowed.summary.json")


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


def load_sessions(paths):
    sessions = {}
    session_to_source = {}
    for path in paths:
        if not path.exists():
            raise FileNotFoundError(path)
        for _, session in iter_jsonl(path):
            session_id = session.get("session_id")
            if not session_id:
                raise ValueError(f"{path}: missing session_id")
            if session_id in sessions:
                raise ValueError(f"duplicate session_id: {session_id}")
            sessions[session_id] = session
            session_to_source[session_id] = str(path)
    return sessions, session_to_source


def load_jobs(path):
    jobs = {}
    boundary_maps = {}
    for _, job in iter_jsonl(path):
        job_id = job.get("job_id")
        if not job_id:
            raise ValueError(f"{path}: missing job_id")
        if job_id in jobs:
            raise ValueError(f"duplicate job_id: {job_id}")
        source = job.get("source", {})
        session_id = source.get("session_id")
        if not session_id:
            raise ValueError(f"{path}: job {job_id} missing source.session_id")
        jobs[job_id] = job
        boundary_maps[job_id] = {
            item.get("boundary_id"): item
            for item in job.get("candidate_boundaries", [])
            if item.get("boundary_id")
        }
    return jobs, boundary_maps


def load_decisions(path):
    decisions = {}
    for _, row in iter_jsonl(path):
        job_id = row.get("job_id")
        if not job_id:
            raise ValueError(f"{path}: missing job_id")
        if job_id in decisions:
            raise ValueError(f"duplicate decision row for job_id: {job_id}")
        decisions[job_id] = row
    return decisions


def normalize_decision(value):
    return str(value or "").strip().lower()


def collect_cut_points(job, decision_row, boundary_map, strict):
    message_count = len(job.get("messages", []))
    cuts = {}

    for item in decision_row.get("decisions", []):
        if normalize_decision(item.get("decision")) != "cut":
            continue
        boundary_id = item.get("boundary_id")
        boundary = boundary_map.get(boundary_id)
        if boundary is None:
            if strict:
                raise ValueError(f"{job['job_id']}: unknown boundary_id {boundary_id}")
            continue
        right = int(boundary["right_message_index"])
        left = int(boundary["left_message_index"])
        if right != left + 1 or not 0 < right < message_count:
            raise ValueError(f"{job['job_id']}: invalid cut indexes for {boundary_id}")
        cuts[right] = {
            "kind": "candidate_boundary",
            "boundary_id": boundary_id,
            "left_message_index": left,
            "right_message_index": right,
            "confidence": item.get("confidence"),
            "reason": item.get("reason", ""),
            "gap_sec": boundary.get("gap_sec"),
            "gap_min": boundary.get("gap_min"),
            "bucket": boundary.get("bucket"),
        }

    for index, item in enumerate(decision_row.get("extra_cuts", []), 1):
        left = item.get("left_message_index")
        right = item.get("right_message_index")
        if not isinstance(left, int) or not isinstance(right, int):
            raise ValueError(f"{job['job_id']}: extra_cuts[{index}] indexes must be int")
        if right != left + 1 or not 0 < right < message_count:
            raise ValueError(f"{job['job_id']}: invalid extra cut indexes {left}/{right}")
        cuts[right] = {
            "kind": "extra_cut",
            "boundary_id": f"{job['job_id']}_extra_{index:04d}",
            "left_message_index": left,
            "right_message_index": right,
            "confidence": item.get("confidence"),
            "reason": item.get("reason", ""),
        }

    return cuts


def clean_message(message):
    return {
        key: value
        for key, value in message.items()
        if not str(key).startswith("_")
    }


def build_segment(session, source_file, job, route, segment_index, start_index, end_index, cut_before):
    messages = [clean_message(item) for item in session.get("messages", [])[start_index:end_index]]
    if not messages:
        raise ValueError(f"{session['session_id']}: empty segment {start_index}:{end_index}")

    segment_id = f"{session['session_id']}_seg{segment_index:04d}"
    return {
        "schema_version": 1,
        "segment_id": segment_id,
        "route": route,
        "platform": session.get("platform") or job.get("source", {}).get("platform"),
        "source_session_id": session.get("session_id"),
        "source_job_id": job.get("job_id"),
        "source_file": source_file,
        "start": messages[0].get("time"),
        "end": messages[-1].get("time"),
        "message_count": len(messages),
        "source_message_start_index": start_index,
        "source_message_end_index": end_index - 1,
        "cut_before": cut_before,
        "messages": messages,
    }


def percentile(sorted_values, p):
    if not sorted_values:
        return None
    index = int((len(sorted_values) - 1) * p)
    return sorted_values[index]


def apply_splits(session_sources, jobs_path, decisions_path, output_path, summary_path, route, strict):
    sessions, session_to_source = load_sessions(session_sources)
    jobs, boundary_maps = load_jobs(jobs_path)
    decisions = load_decisions(decisions_path)

    missing_decisions = sorted(set(jobs) - set(decisions))
    unknown_decisions = sorted(set(decisions) - set(jobs))
    if strict and missing_decisions:
        raise ValueError(f"missing decisions for {len(missing_decisions)} jobs; first={missing_decisions[:5]}")
    if strict and unknown_decisions:
        raise ValueError(f"decisions contain {len(unknown_decisions)} unknown jobs; first={unknown_decisions[:5]}")

    output_path.parent.mkdir(parents=True, exist_ok=True)
    if summary_path:
        summary_path.parent.mkdir(parents=True, exist_ok=True)

    stats = Counter()
    segment_counts = []
    message_counts = []
    cut_counts = []

    with output_path.open("w", encoding="utf-8", newline="\n") as f:
        for job_id in sorted(jobs):
            job = jobs[job_id]
            session_id = job.get("source", {}).get("session_id")
            session = sessions.get(session_id)
            if session is None:
                raise ValueError(f"{job_id}: source session not found: {session_id}")

            job_message_count = len(job.get("messages", []))
            session_messages = session.get("messages", [])
            if job_message_count != len(session_messages):
                raise ValueError(
                    f"{job_id}: message count mismatch job={job_message_count} session={len(session_messages)}"
                )

            decision_row = decisions.get(job_id, {"job_id": job_id, "decisions": [], "extra_cuts": []})
            cuts = collect_cut_points(
                job=job,
                decision_row=decision_row,
                boundary_map=boundary_maps[job_id],
                strict=strict,
            )
            cut_indexes = sorted(cuts)

            starts = [0] + cut_indexes
            ends = cut_indexes + [len(session_messages)]
            session_segment_count = 0

            for segment_index, (start_index, end_index) in enumerate(zip(starts, ends), 1):
                cut_before = None if start_index == 0 else cuts[start_index]
                segment = build_segment(
                    session=session,
                    source_file=session_to_source[session_id],
                    job=job,
                    route=route,
                    segment_index=segment_index,
                    start_index=start_index,
                    end_index=end_index,
                    cut_before=cut_before,
                )
                write_jsonl_row(f, segment)
                stats["segments_total"] += 1
                stats[f"segments_platform_{segment['platform']}"] += 1
                message_counts.append(segment["message_count"])
                session_segment_count += 1

            stats["jobs_total"] += 1
            stats["source_messages_total"] += len(session_messages)
            stats["cuts_total"] += len(cut_indexes)
            segment_counts.append(session_segment_count)
            cut_counts.append(len(cut_indexes))

    sorted_segment_counts = sorted(segment_counts)
    sorted_message_counts = sorted(message_counts)
    summary = {
        "session_sources": [str(path) for path in session_sources],
        "jobs": str(jobs_path),
        "decisions": str(decisions_path),
        "output": str(output_path),
        "route": route,
        "strict": strict,
        "jobs_total": stats["jobs_total"],
        "segments_total": stats["segments_total"],
        "source_messages_total": stats["source_messages_total"],
        "cuts_total": stats["cuts_total"],
        "missing_decisions": len(missing_decisions),
        "unknown_decisions": len(unknown_decisions),
        "segments_per_job": {
            "min": sorted_segment_counts[0] if sorted_segment_counts else None,
            "p50": percentile(sorted_segment_counts, 0.50),
            "p90": percentile(sorted_segment_counts, 0.90),
            "p95": percentile(sorted_segment_counts, 0.95),
            "p99": percentile(sorted_segment_counts, 0.99),
            "max": sorted_segment_counts[-1] if sorted_segment_counts else None,
        },
        "messages_per_segment": {
            "min": sorted_message_counts[0] if sorted_message_counts else None,
            "p50": percentile(sorted_message_counts, 0.50),
            "p90": percentile(sorted_message_counts, 0.90),
            "p95": percentile(sorted_message_counts, 0.95),
            "p99": percentile(sorted_message_counts, 0.99),
            "max": sorted_message_counts[-1] if sorted_message_counts else None,
        },
        "platform_segments": {
            key.removeprefix("segments_platform_"): value
            for key, value in sorted(stats.items())
            if key.startswith("segments_platform_")
        },
    }

    if summary_path:
        summary_path.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=False, indent=2))


def main():
    parser = argparse.ArgumentParser(
        description="Apply agent cut decisions to original 60m sessions and write final training segments."
    )
    parser.add_argument("--session-source", action="append", type=Path)
    parser.add_argument("--jobs", type=Path, default=DEFAULT_JOBS)
    parser.add_argument("--decisions", type=Path, default=DEFAULT_DECISIONS)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--summary", type=Path, default=DEFAULT_SUMMARY)
    parser.add_argument("--route", default="api_allowed")
    parser.add_argument("--no-strict", action="store_true")
    args = parser.parse_args()

    apply_splits(
        session_sources=args.session_source or DEFAULT_SESSION_SOURCES,
        jobs_path=args.jobs,
        decisions_path=args.decisions,
        output_path=args.output,
        summary_path=args.summary,
        route=args.route,
        strict=not args.no_strict,
    )


if __name__ == "__main__":
    main()
