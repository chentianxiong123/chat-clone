# Workspace Layout

The repository is split into release-safe code/docs and a local private workspace.

Release-safe paths:

- `scripts/`: executable pipeline scripts.
- `config/`: policy/configuration templates.
- `docs/`: workflow documentation.

Private/generated paths:

- `workspace/`: numbered local pipeline artifacts.
- `raw/`, `chat_records/`, `models/`, `adapters/`, `bin/`: local private inputs/tools.

## Current Workspace

Only the final embedding artifact is retained; all intermediate stages
(01 sessions → 06 final segments) were deleted after the vector store was built.

```
workspace/
└── 07_rag_embedding/
    ├── stores/
    │   └── qwen_persona_rag.sqlite   ← 181MB 向量库（唯一保留产物）
    └── README.md                     ← 已归档到本文件
```

## 07 RAG Embedding

RAG/embedding 唯一产物目录，包含最终向量库 `stores/qwen_persona_rag.sqlite`
（1024 维，qwen3-embedding-0.6b，17,846 chunks）。

构建流水线：

1. `scripts/build_retrieval_docs.py` — 从 final_segments 拆分检索文档 chunks。
2. `scripts/embed_worker_sqlite_vec.py` — 并发 embedding，写入 sqlite-vec。
3. `scripts/query_rag.py` / `scripts/query_test.py` — 向量检索查询测试。

> 中间产物 `retrieval_docs/*.jsonl` 已删除，如需重建需重跑 01→07 全流水线。

## Retired Workspace Stages

中间产物目录（已删除，仅记录历史流水线结构）：

- `00_source_clean/`: cleaned source data notes.
- `01_sessions_60m/`: 60-minute session outputs.
- `02_policy_route_sensitive_split/`: API-allowed/blocked routing.
- `03_agent_split_jobs/`: large segment jobs.
- `04_ai_batch_workspaces/`: resumable AI/agent queue workspaces.
- `05_agent_decisions/`: merged/ repaired/ normalized agent split decisions.
- `06_final_segments/`: final cleaned segment outputs.
- `08_sft_datasets/`: SFT/LoRA dataset outputs.
- `09_train_runs/`: training logs, adapters, benchmarks.
- `90_logs/`: local logs.
- `99_archive/`: old experiments.

The sensitive routing branch under `02_policy_route_sensitive_split/` must not be merged
implicitly. Keep `api_allowed` and `api_blocked`/manual-review data separate.