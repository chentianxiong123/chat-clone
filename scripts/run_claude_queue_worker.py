import argparse
import json
import shutil
import subprocess
from pathlib import Path


def safe_log(path, text):
    with path.open("a", encoding="utf-8", newline="\n") as f:
        f.write(text.rstrip() + "\n")


def build_prompt(job_path, decision_path, prompt_path):
    return f"""You are in Windows workspace D:\\files\\qwen-chat.

Process exactly one job:
{job_path}

Write output to:
{decision_path}

Read the instruction file first:
{prompt_path}

Rules:
1. Read the job JSON.
2. Judge only candidate_boundaries.
3. Write exactly one JSON object to the output file. No markdown.
4. If there are no candidate_boundaries, write:
{{"job_id":"...","decisions":[],"extra_cuts":[]}}
5. If there are candidate_boundaries, use:
{{"job_id":"...","decisions":[{{"boundary_id":"...","decision":"cut|keep|uncertain","confidence":0.0,"reason":"max 30 Chinese chars, do not quote source text"}}],"extra_cuts":[]}}
6. Do not quote original chat text in reason.
7. After writing and validating the decision file, delete this in_progress job file:
{job_path}
8. Print only: done
"""


def validate_decision(path):
    obj = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(obj, dict):
        raise ValueError("decision is not an object")
    if "job_id" not in obj:
        raise ValueError("missing job_id")
    if not isinstance(obj.get("decisions"), list):
        raise ValueError("decisions is not a list")
    if not isinstance(obj.get("extra_cuts"), list):
        raise ValueError("extra_cuts is not a list")
    return obj


def run_worker(queue_root, max_jobs, worker_name):
    queue_root = queue_root.resolve()
    pending = queue_root / "pending"
    in_progress = queue_root / "in_progress"
    done = queue_root / "done"
    failed = queue_root / "failed"
    prompt_path = queue_root / "PROMPT.md"
    log_path = queue_root / f"{worker_name}.log"

    for path in (pending, in_progress, done, failed):
        path.mkdir(parents=True, exist_ok=True)

    processed = 0
    failed_count = 0

    while processed < max_jobs:
        jobs = sorted(pending.glob("*.job.json"))
        if not jobs:
            safe_log(log_path, "no pending jobs")
            break

        source = jobs[0]
        job_id = source.name.removesuffix(".job.json")
        active = in_progress / source.name
        decision = done / f"{job_id}.decision.json"

        shutil.move(str(source), str(active))
        prompt = build_prompt(active, decision, prompt_path)

        try:
            result = subprocess.run(
                ["claude", "--dangerously-skip-permissions", "-p", prompt],
                cwd=str(Path.cwd()),
                text=True,
                encoding="utf-8",
                errors="replace",
                capture_output=True,
                timeout=900,
            )
            if result.returncode != 0:
                raise RuntimeError(f"claude exit {result.returncode}: {result.stderr[-500:]}")
            if not decision.exists():
                raise RuntimeError("decision file was not created")
            validate_decision(decision)
            if active.exists():
                active.unlink()
            processed += 1
            safe_log(log_path, f"done {job_id} {result.stdout.strip()}")
        except Exception as exc:
            failed_count += 1
            failed_path = failed / source.name
            if active.exists():
                shutil.move(str(active), str(failed_path))
            safe_log(log_path, f"failed {job_id} {exc}")

    print(json.dumps({
        "queue_root": str(queue_root),
        "worker_name": worker_name,
        "processed": processed,
        "failed": failed_count,
        "max_jobs": max_jobs,
    }, ensure_ascii=False, indent=2))


def main():
    parser = argparse.ArgumentParser(description="Run a resumable Claude queue worker.")
    parser.add_argument(
        "--queue-root",
        type=Path,
        default=Path("workspace/04_ai_batch_workspaces/agent_queues/api_allowed_60m"),
    )
    parser.add_argument("--max-jobs", type=int, default=20)
    parser.add_argument("--worker-name", default="claude_worker")
    args = parser.parse_args()
    run_worker(args.queue_root, args.max_jobs, args.worker_name)


if __name__ == "__main__":
    main()
