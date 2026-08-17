import argparse
import shutil
from pathlib import Path


DEFAULT_QUEUE_ROOT = Path("workspace/04_ai_batch_workspaces/agent_queues/api_allowed_60m")


def requeue(queue_root):
    in_progress = queue_root / "in_progress"
    pending = queue_root / "pending"
    pending.mkdir(parents=True, exist_ok=True)
    moved = 0
    for path in in_progress.glob("*.job.json"):
        target = pending / path.name
        if target.exists():
            raise SystemExit(f"target already exists: {target}")
        shutil.move(str(path), str(target))
        moved += 1
    print(f"requeued {moved} in-progress jobs")


def main():
    parser = argparse.ArgumentParser(description="Move interrupted in-progress jobs back to pending.")
    parser.add_argument("--queue-root", type=Path, default=DEFAULT_QUEUE_ROOT)
    args = parser.parse_args()
    requeue(args.queue_root)


if __name__ == "__main__":
    main()
