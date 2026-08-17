# Workspace Layout

The repository is split into release-safe code/docs and a local private workspace.

Release-safe paths:

- `scripts/`: executable pipeline scripts.
- `config/` and `configs/`: policy/configuration templates.
- `docs/`: workflow documentation.

Private/generated paths:

- `workspace/`: numbered local pipeline artifacts.
- `raw/`, `chat_records/`, `models/`, `adapters/`, `bin/`: local private inputs/tools.

## Numbered Workspace

- `workspace/00_source_clean/`: notes for cleaned source data. Actual cleaned JSONL files currently live in `chat_records/`.
- `workspace/01_sessions_60m/`: 60-minute session outputs from `scripts/build_sessions.py`.
- `workspace/02_policy_route_sensitive_split/`: API-allowed and API-blocked sensitive-policy routing outputs.
- `workspace/03_agent_split_jobs/`: large segment jobs for agent boundary decisions.
- `workspace/04_ai_batch_workspaces/`: resumable AI/agent queue workspaces for large batch processing.
- `workspace/05_agent_decisions/`: merged, repaired, and normalized agent split decisions.
- `workspace/06_final_segments/`: final cleaned segment outputs.
- `workspace/07_rag_embedding/`: reserved for retrieval documents, embedding vectors, and local indexes.
- `workspace/08_sft_datasets/`: SFT/LoRA dataset outputs.
- `workspace/09_train_runs/`: training logs, adapters, and benchmark results.
- `workspace/90_logs/`: local logs.
- `workspace/99_archive/`: old experiments and retired artifacts.

Current final segment file:

`workspace/06_final_segments/final_segments/final_segments_v1_allowed.jsonl`

Current normalized decision file:

`workspace/05_agent_decisions/agent_decisions/large_segments_60m_api_allowed.decisions.normalized.jsonl`

The sensitive routing branch under `workspace/02_policy_route_sensitive_split/` must not be merged implicitly. Keep `api_allowed` and `api_blocked`/manual-review data separate.
