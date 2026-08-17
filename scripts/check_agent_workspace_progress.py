import argparse
import json
from pathlib import Path


DEFAULT_WORKSPACE_ROOT = Path("workspace/04_ai_batch_workspaces/agent_queues/api_allowed_60m")
DEFAULT_OUTPUT = Path("workspace/04_ai_batch_workspaces/agent_queues/api_allowed_60m/progress.summary.json")


def iter_jsonl(path):
    with path.open("r", encoding="utf-8") as f:
        for line_no, line in enumerate(f, 1):
            line = line.strip()
            if not line:
                continue
            try:
                yield line_no, json.loads(line)
            except json.JSONDecodeError as exc:
                yield line_no, {"__json_error__": str(exc)}


def read_job_ids(path):
    job_ids = []
    for line_no, row in iter_jsonl(path):
        job_id = row.get("job_id")
        if not job_id:
            raise ValueError(f"{path}:{line_no}: missing job_id")
        job_ids.append(job_id)
    return job_ids


def read_decision_job_ids(path):
    job_ids = []
    errors = []
    if not path.exists():
        return job_ids, [{"line_no": None, "error": "missing decisions.jsonl"}]
    for line_no, row in iter_jsonl(path):
        if "__json_error__" in row:
            errors.append({"line_no": line_no, "error": row["__json_error__"]})
            continue
        job_id = row.get("job_id")
        if not job_id:
            errors.append({"line_no": line_no, "error": "missing job_id"})
            continue
        job_ids.append(job_id)
    return job_ids, errors


def check_progress(workspace_root, output_path):
    shards = []
    total_jobs = 0
    total_done = 0
    total_errors = 0

    for shard_dir in sorted(path for path in workspace_root.glob("shard_*") if path.is_dir()):
        jobs_path = shard_dir / "jobs.jsonl"
        decisions_path = shard_dir / "decisions.jsonl"
        job_ids = read_job_ids(jobs_path)
        decision_ids, errors = read_decision_job_ids(decisions_path)

        job_set = set(job_ids)
        decision_set = set(decision_ids)
        duplicate_decisions = len(decision_ids) - len(decision_set)
        unknown_decisions = sorted(decision_set - job_set)
        completed = sorted(job_set & decision_set)
        missing = [job_id for job_id in job_ids if job_id not in decision_set]

        shard_summary = {
            "shard": shard_dir.name,
            "path": str(shard_dir),
            "jobs": len(job_ids),
            "completed": len(completed),
            "missing": len(missing),
            "percent": round((len(completed) / len(job_ids) * 100) if job_ids else 0, 2),
            "decision_rows": len(decision_ids),
            "duplicate_decision_rows": duplicate_decisions,
            "unknown_decision_job_ids": unknown_decisions[:20],
            "unknown_decision_count": len(unknown_decisions),
            "error_count": len(errors),
            "errors": errors[:20],
            "first_missing_job_ids": missing[:20],
            "status": "complete" if len(missing) == 0 and not errors and not unknown_decisions and duplicate_decisions == 0 else "incomplete",
        }
        shards.append(shard_summary)
        total_jobs += len(job_ids)
        total_done += len(completed)
        total_errors += len(errors) + len(unknown_decisions) + duplicate_decisions

    summary = {
        "workspace_root": str(workspace_root),
        "total_shards": len(shards),
        "total_jobs": total_jobs,
        "completed_jobs": total_done,
        "missing_jobs": total_jobs - total_done,
        "percent": round((total_done / total_jobs * 100) if total_jobs else 0, 2),
        "error_count": total_errors,
        "complete_shards": sum(1 for item in shards if item["status"] == "complete"),
        "incomplete_shards": sum(1 for item in shards if item["status"] != "complete"),
        "shards": shards,
    }

    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=False, indent=2))


def main():
    parser = argparse.ArgumentParser(description="Check per-shard agent workspace progress.")
    parser.add_argument("--workspace-root", type=Path, default=DEFAULT_WORKSPACE_ROOT)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    args = parser.parse_args()
    check_progress(args.workspace_root, args.output)


if __name__ == "__main__":
    main()
