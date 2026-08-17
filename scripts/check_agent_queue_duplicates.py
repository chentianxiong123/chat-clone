import argparse
import json
from collections import defaultdict
from pathlib import Path


DEFAULT_QUEUE_ROOT = Path("workspace/04_ai_batch_workspaces/agent_queues/api_allowed_60m")


def check_duplicates(queue_root):
    done = queue_root / "done"
    by_json_job_id = defaultdict(list)
    by_file_job_id = defaultdict(list)
    errors = []

    for path in sorted(done.glob("*.decision.json")):
        file_job_id = path.name.removesuffix(".decision.json")
        by_file_job_id[file_job_id].append(str(path))
        try:
            obj = json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            errors.append({"file": str(path), "error": f"invalid json: {exc}"})
            continue
        json_job_id = obj.get("job_id")
        if not json_job_id:
            errors.append({"file": str(path), "error": "missing job_id"})
            continue
        by_json_job_id[json_job_id].append(str(path))
        if json_job_id != file_job_id:
            errors.append({
                "file": str(path),
                "error": "file job_id does not match json job_id",
                "file_job_id": file_job_id,
                "json_job_id": json_job_id,
            })

    duplicate_json_job_ids = {
        job_id: paths
        for job_id, paths in by_json_job_id.items()
        if len(paths) > 1
    }
    duplicate_file_job_ids = {
        job_id: paths
        for job_id, paths in by_file_job_id.items()
        if len(paths) > 1
    }

    summary = {
        "queue_root": str(queue_root),
        "done_files": sum(len(paths) for paths in by_file_job_id.values()),
        "unique_json_job_ids": len(by_json_job_id),
        "duplicate_json_job_id_count": len(duplicate_json_job_ids),
        "duplicate_file_job_id_count": len(duplicate_file_job_ids),
        "error_count": len(errors),
        "duplicate_json_job_ids": duplicate_json_job_ids,
        "duplicate_file_job_ids": duplicate_file_job_ids,
        "errors": errors,
        "ok": not duplicate_json_job_ids and not duplicate_file_job_ids and not errors,
    }
    output = queue_root / "queue_duplicates.summary.json"
    output.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=False, indent=2))


def main():
    parser = argparse.ArgumentParser(description="Check duplicate completed queue decisions.")
    parser.add_argument("--queue-root", type=Path, default=DEFAULT_QUEUE_ROOT)
    args = parser.parse_args()
    check_duplicates(args.queue_root)


if __name__ == "__main__":
    main()
