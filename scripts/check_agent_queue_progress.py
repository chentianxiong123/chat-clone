import argparse
import json
from pathlib import Path


DEFAULT_QUEUE_ROOT = Path("workspace/04_ai_batch_workspaces/agent_queues/api_allowed_60m")


def count_files(path, pattern):
    return len(list(path.glob(pattern))) if path.exists() else 0


def check_queue(queue_root):
    pending = count_files(queue_root / "pending", "*.job.json")
    in_progress = count_files(queue_root / "in_progress", "*.job.json")
    done = count_files(queue_root / "done", "*.decision.json")
    failed = count_files(queue_root / "failed", "*")
    total = pending + in_progress + done + failed
    summary = {
        "queue_root": str(queue_root),
        "total_seen": total,
        "pending": pending,
        "in_progress": in_progress,
        "done": done,
        "failed": failed,
        "finished": done + failed,
        "percent_done": round((done / total * 100) if total else 0, 2),
        "complete": pending == 0 and in_progress == 0 and failed == 0 and total > 0,
    }
    (queue_root / "queue_progress.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    print(json.dumps(summary, ensure_ascii=False, indent=2))


def main():
    parser = argparse.ArgumentParser(description="Check interrupt-safe agent queue progress.")
    parser.add_argument("--queue-root", type=Path, default=DEFAULT_QUEUE_ROOT)
    args = parser.parse_args()
    check_queue(args.queue_root)


if __name__ == "__main__":
    main()
