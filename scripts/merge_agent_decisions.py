import argparse
import json
from collections import Counter
from pathlib import Path


DEFAULT_WORKSPACE_ROOT = Path("workspace/04_ai_batch_workspaces/agent_queues/api_allowed_60m")
DEFAULT_OUTPUT = Path("workspace/05_agent_decisions/agent_decisions/large_segments_60m_api_allowed.decisions.jsonl")
DEFAULT_SUMMARY = Path("workspace/05_agent_decisions/agent_decisions/large_segments_60m_api_allowed.decisions.summary.json")
VALID_DECISIONS = {"cut", "keep", "uncertain"}


def iter_jsonl(path, allow_empty=False):
    if allow_empty and path.exists() and path.stat().st_size == 0:
        return
    with path.open("r", encoding="utf-8") as f:
        for line_no, line in enumerate(f, 1):
            line = line.strip()
            if not line:
                continue
            try:
                yield line_no, json.loads(line)
            except json.JSONDecodeError as exc:
                raise ValueError(f"{path}:{line_no}: invalid json: {exc}") from exc


def load_jobs(workspace_root):
    jobs = {}
    job_to_shard = {}
    boundary_ids = {}
    message_counts = {}

    shard_dirs = sorted(path for path in workspace_root.glob("shard_*") if path.is_dir())
    for shard_dir in shard_dirs:
        jobs_path = shard_dir / "jobs.jsonl"
        if not jobs_path.exists():
            continue
        for _, job in iter_jsonl(jobs_path):
            job_id = job.get("job_id")
            if not job_id:
                raise ValueError(f"{jobs_path}: missing job_id")
            if job_id in jobs:
                raise ValueError(f"duplicate job_id in jobs: {job_id}")
            jobs[job_id] = job
            job_to_shard[job_id] = shard_dir.name
            boundary_ids[job_id] = {item.get("boundary_id") for item in job.get("candidate_boundaries", [])}
            message_counts[job_id] = len(job.get("messages", []))
    return jobs, job_to_shard, boundary_ids, message_counts


def validate_confidence(value):
    if not isinstance(value, (int, float)):
        return False
    return 0 <= float(value) <= 1


def validate_decision_row(row, shard_name, jobs, job_to_shard, boundary_ids, message_counts):
    errors = []
    job_id = row.get("job_id")
    if not job_id:
        errors.append("missing job_id")
        return errors
    if job_id not in jobs:
        errors.append("unknown job_id")
        return errors
    if job_to_shard.get(job_id) != shard_name:
        errors.append("job_id belongs to another shard")

    decisions = row.get("decisions", [])
    if not isinstance(decisions, list):
        errors.append("decisions must be list")
    else:
        seen_boundaries = set()
        for index, item in enumerate(decisions):
            if not isinstance(item, dict):
                errors.append(f"decisions[{index}] must be object")
                continue
            boundary_id = item.get("boundary_id")
            if boundary_id not in boundary_ids[job_id]:
                errors.append(f"decisions[{index}] unknown boundary_id")
            if boundary_id in seen_boundaries:
                errors.append(f"decisions[{index}] duplicate boundary_id")
            seen_boundaries.add(boundary_id)
            if item.get("decision") not in VALID_DECISIONS:
                errors.append(f"decisions[{index}] invalid decision")
            if not validate_confidence(item.get("confidence")):
                errors.append(f"decisions[{index}] invalid confidence")
            reason = item.get("reason", "")
            if not isinstance(reason, str):
                errors.append(f"decisions[{index}] reason must be string")

    extra_cuts = row.get("extra_cuts", [])
    if not isinstance(extra_cuts, list):
        errors.append("extra_cuts must be list")
    else:
        message_count = message_counts[job_id]
        for index, item in enumerate(extra_cuts):
            if not isinstance(item, dict):
                errors.append(f"extra_cuts[{index}] must be object")
                continue
            left = item.get("left_message_index")
            right = item.get("right_message_index")
            if not isinstance(left, int) or not isinstance(right, int):
                errors.append(f"extra_cuts[{index}] indexes must be int")
                continue
            if right != left + 1:
                errors.append(f"extra_cuts[{index}] right must equal left + 1")
            if left < 0 or right >= message_count:
                errors.append(f"extra_cuts[{index}] index out of range")
            if not validate_confidence(item.get("confidence")):
                errors.append(f"extra_cuts[{index}] invalid confidence")
            reason = item.get("reason", "")
            if not isinstance(reason, str):
                errors.append(f"extra_cuts[{index}] reason must be string")

    return errors


def merge_decisions(workspace_root, output_path, summary_path, errors_path, allow_incomplete):
    jobs, job_to_shard, boundary_ids, message_counts = load_jobs(workspace_root)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    summary_path.parent.mkdir(parents=True, exist_ok=True)
    if errors_path:
        errors_path.parent.mkdir(parents=True, exist_ok=True)

    rows_by_job = {}
    errors = []
    stats = {
        "decision_values": Counter(),
        "rows_by_shard": Counter(),
        "errors_by_type": Counter(),
    }

    shard_dirs = sorted(path for path in workspace_root.glob("shard_*") if path.is_dir())
    for shard_dir in shard_dirs:
        decisions_path = shard_dir / "decisions.jsonl"
        if not decisions_path.exists():
            errors.append({"shard": shard_dir.name, "error": "missing decisions.jsonl"})
            stats["errors_by_type"]["missing_decisions_file"] += 1
            continue
        for line_no, row in iter_jsonl(decisions_path, allow_empty=True) or []:
            job_id = row.get("job_id")
            row_errors = validate_decision_row(
                row=row,
                shard_name=shard_dir.name,
                jobs=jobs,
                job_to_shard=job_to_shard,
                boundary_ids=boundary_ids,
                message_counts=message_counts,
            )
            if job_id in rows_by_job:
                row_errors.append("duplicate decision row for job_id")
            if row_errors:
                for error in row_errors:
                    stats["errors_by_type"][error] += 1
                errors.append({
                    "shard": shard_dir.name,
                    "line_no": line_no,
                    "job_id": job_id,
                    "errors": row_errors,
                })
                continue
            rows_by_job[job_id] = row
            stats["rows_by_shard"][shard_dir.name] += 1
            for item in row.get("decisions", []):
                stats["decision_values"][item.get("decision")] += 1

    missing_jobs = sorted(set(jobs) - set(rows_by_job))
    if missing_jobs and not allow_incomplete:
        stats["errors_by_type"]["missing_job_decision"] += len(missing_jobs)
        errors.append({
            "error": "missing job decisions",
            "count": len(missing_jobs),
            "first_missing_job_ids": missing_jobs[:20],
        })

    with output_path.open("w", encoding="utf-8", newline="\n") as f:
        for job_id in sorted(rows_by_job, key=lambda value: (job_to_shard[value], value)):
            f.write(json.dumps(rows_by_job[job_id], ensure_ascii=False, separators=(",", ":")) + "\n")

    if errors_path:
        with errors_path.open("w", encoding="utf-8", newline="\n") as f:
            for error in errors:
                f.write(json.dumps(error, ensure_ascii=False, separators=(",", ":")) + "\n")

    summary = {
        "workspace_root": str(workspace_root),
        "output": str(output_path),
        "errors_output": str(errors_path) if errors_path else None,
        "expected_jobs": len(jobs),
        "merged_jobs": len(rows_by_job),
        "missing_jobs": len(missing_jobs),
        "error_count": len(errors),
        "decision_values": dict(stats["decision_values"]),
        "rows_by_shard": dict(stats["rows_by_shard"]),
        "errors_by_type": dict(stats["errors_by_type"]),
        "complete": len(missing_jobs) == 0 and len(errors) == 0,
    }
    summary_path.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=False, indent=2))

    if errors and not allow_incomplete:
        raise SystemExit(1)


def main():
    parser = argparse.ArgumentParser(description="Validate and merge per-shard agent split decisions.")
    parser.add_argument("--workspace-root", type=Path, default=DEFAULT_WORKSPACE_ROOT)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--summary", type=Path, default=DEFAULT_SUMMARY)
    parser.add_argument(
        "--errors",
        type=Path,
        default=Path(
            "workspace/05_agent_decisions/agent_decisions/large_segments_60m_api_allowed.decisions.errors.jsonl"
        ),
    )
    parser.add_argument("--allow-incomplete", action="store_true")
    args = parser.parse_args()

    merge_decisions(
        workspace_root=args.workspace_root,
        output_path=args.output,
        summary_path=args.summary,
        errors_path=args.errors,
        allow_incomplete=args.allow_incomplete,
    )


if __name__ == "__main__":
    main()
