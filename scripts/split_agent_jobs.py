import argparse
import json
import math
import shutil
from pathlib import Path


DEFAULT_INPUT = Path("data/agent_split_jobs/large_segments_60m_api_allowed.jsonl")
DEFAULT_OUTPUT_ROOT = Path("data/agent_workspaces/api_allowed_60m")
DEFAULT_PROMPT = Path(r"C:\Users\a1\Desktop\agent-large-segment-split-prompt.md")


def iter_jsonl(path):
    with path.open("r", encoding="utf-8") as f:
        for line_no, line in enumerate(f, 1):
            line = line.strip()
            if not line:
                continue
            try:
                yield json.loads(line)
            except json.JSONDecodeError as exc:
                raise ValueError(f"{path}:{line_no}: invalid json: {exc}") from exc


def write_jsonl(path, rows):
    with path.open("w", encoding="utf-8", newline="\n") as f:
        for row in rows:
            f.write(json.dumps(row, ensure_ascii=False, separators=(",", ":")) + "\n")


def split_evenly(rows, shard_count):
    size = math.ceil(len(rows) / shard_count)
    return [rows[index:index + size] for index in range(0, len(rows), size)]


def split_by_jobs_per_shard(rows, jobs_per_shard):
    return [rows[index:index + jobs_per_shard] for index in range(0, len(rows), jobs_per_shard)]


def write_worker_readme(path, shard_name, job_count):
    text = f"""# Agent 工作区：{shard_name}

本工作区只处理当前目录里的 `jobs.jsonl`。

输入：

```text
jobs.jsonl
```

输出：

```text
decisions.jsonl
```

要求：

1. 每个 job 输出一行 JSON。
2. 不要改 `jobs.jsonl`。
3. 不要写其他 shard 的目录。
4. 只输出切点决策，不改写原文。
5. 如果某个 job 不确定，可以把候选边界标成 `uncertain`，不要强行切。

当前 shard job 数：{job_count}

单行输出格式：

```json
{{"job_id":"...","decisions":[{{"boundary_id":"...","decision":"cut|keep|uncertain","confidence":0.0,"reason":"不超过30字，不引用原文"}}],"extra_cuts":[]}}
```
"""
    path.write_text(text, encoding="utf-8")


def build_workspaces(input_path, output_root, prompt_path, shard_count, jobs_per_shard, force):
    if output_root.exists():
        if not force:
            raise SystemExit(f"output exists: {output_root} (use --force to overwrite)")
        shutil.rmtree(output_root)
    output_root.mkdir(parents=True, exist_ok=True)

    rows = list(iter_jsonl(input_path))
    if not rows:
        raise SystemExit(f"input has no jobs: {input_path}")

    if jobs_per_shard:
        shards = split_by_jobs_per_shard(rows, jobs_per_shard)
    else:
        shards = split_evenly(rows, shard_count)

    prompt_text = prompt_path.read_text(encoding="utf-8") if prompt_path.exists() else ""
    if prompt_text:
        (output_root / "PROMPT.md").write_text(prompt_text, encoding="utf-8")

    shard_summaries = []
    for index, shard_rows in enumerate(shards, 1):
        shard_name = f"shard_{index:04d}"
        shard_dir = output_root / shard_name
        shard_dir.mkdir(parents=True, exist_ok=True)
        write_jsonl(shard_dir / "jobs.jsonl", shard_rows)
        (shard_dir / "decisions.jsonl").write_text("", encoding="utf-8")
        write_worker_readme(shard_dir / "README.md", shard_name, len(shard_rows))
        shard_summaries.append({
            "shard": shard_name,
            "path": str(shard_dir),
            "jobs": len(shard_rows),
            "first_job_id": shard_rows[0].get("job_id"),
            "last_job_id": shard_rows[-1].get("job_id"),
            "decisions_output": str(shard_dir / "decisions.jsonl"),
        })

    summary = {
        "input": str(input_path),
        "output_root": str(output_root),
        "prompt": str(output_root / "PROMPT.md") if prompt_text else None,
        "total_jobs": len(rows),
        "shards": len(shard_summaries),
        "jobs_per_shard": jobs_per_shard,
        "shard_summaries": shard_summaries,
    }
    (output_root / "workspace_manifest.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    print(json.dumps(summary, ensure_ascii=False, indent=2))


def main():
    parser = argparse.ArgumentParser(description="Split agent split jobs into isolated worker workspaces.")
    parser.add_argument("--input", type=Path, default=DEFAULT_INPUT)
    parser.add_argument("--output-root", type=Path, default=DEFAULT_OUTPUT_ROOT)
    parser.add_argument("--prompt", type=Path, default=DEFAULT_PROMPT)
    parser.add_argument("--shards", type=int, default=8)
    parser.add_argument("--jobs-per-shard", type=int)
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args()

    if args.shards < 1:
        raise SystemExit("--shards must be >= 1")
    if args.jobs_per_shard is not None and args.jobs_per_shard < 1:
        raise SystemExit("--jobs-per-shard must be >= 1")

    build_workspaces(
        input_path=args.input,
        output_root=args.output_root,
        prompt_path=args.prompt,
        shard_count=args.shards,
        jobs_per_shard=args.jobs_per_shard,
        force=args.force,
    )


if __name__ == "__main__":
    main()
