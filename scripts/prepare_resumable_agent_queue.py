import argparse
import json
import shutil
from pathlib import Path


DEFAULT_INPUT = Path("workspace/03_agent_split_jobs/agent_jobs/large_segments_60m_api_allowed.jsonl")
DEFAULT_OUTPUT_ROOT = Path("workspace/04_ai_batch_workspaces/agent_queues/api_allowed_60m")
DEFAULT_PROMPT = Path("workspace/03_agent_split_jobs/prompts/agent-large-segment-split-prompt.md")


def safe_name(job_id):
    return "".join(ch if ch.isalnum() or ch in "._-" else "_" for ch in str(job_id))


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


def prepare_queue(input_path, output_root, prompt_path, force):
    if output_root.exists():
        if not force:
            raise SystemExit(f"output exists: {output_root} (use --force to overwrite)")
        shutil.rmtree(output_root)

    pending = output_root / "pending"
    in_progress = output_root / "in_progress"
    done = output_root / "done"
    failed = output_root / "failed"
    for path in (pending, in_progress, done, failed):
        path.mkdir(parents=True, exist_ok=True)

    if prompt_path.exists():
        (output_root / "PROMPT.md").write_text(prompt_path.read_text(encoding="utf-8"), encoding="utf-8")

    rows = []
    for _, job in iter_jsonl(input_path):
        job_id = job.get("job_id")
        if not job_id:
            raise ValueError("job missing job_id")
        rows.append(job)
        job_path = pending / f"{safe_name(job_id)}.job.json"
        job_path.write_text(json.dumps(job, ensure_ascii=False, indent=2), encoding="utf-8")

    readme = f"""# 可中断 Agent 队列

这个目录按“一个 job 一个文件”组织，适合随时中断、随时恢复。

目录：

```text
pending/       尚未处理
in_progress/   正在处理
done/          已完成，里面是 *.decision.json
failed/        处理失败或人工放弃
```

处理规则：

1. 从 `pending` 里取一个 `*.job.json`。
2. 先移动到 `in_progress`。
3. 处理完成后写一个 `done/<job_id>.decision.json`。
4. 删除或保留 `in_progress` 里的 job 都可以；推荐完成后删除。
5. 如果中断，`in_progress` 里的 job 可以重新放回 `pending`。

总 job 数：{len(rows)}
"""
    (output_root / "README.md").write_text(readme, encoding="utf-8")

    manifest = {
        "input": str(input_path),
        "output_root": str(output_root),
        "total_jobs": len(rows),
    }
    (output_root / "queue_manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    print(json.dumps(manifest, ensure_ascii=False, indent=2))


def main():
    parser = argparse.ArgumentParser(description="Prepare an interrupt-safe per-job agent queue.")
    parser.add_argument("--input", type=Path, default=DEFAULT_INPUT)
    parser.add_argument("--output-root", type=Path, default=DEFAULT_OUTPUT_ROOT)
    parser.add_argument("--prompt", type=Path, default=DEFAULT_PROMPT)
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args()
    prepare_queue(args.input, args.output_root, args.prompt, args.force)


if __name__ == "__main__":
    main()
