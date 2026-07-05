# Workspace Layout

The repository is split into release-safe code/docs and a local private workspace.

Release-safe paths:

- `scripts/`: executable pipeline scripts.
- `config/` and `configs/`: policy/configuration templates.
- `docs/`: workflow documentation.

Private/generated paths:

- `workspace/`: generated data, queue artifacts, decisions, and training outputs.
- `raw/`, `chat_records/`, `models/`, `adapters/`, `bin/`: local private inputs/tools.

Current active decision file:

`workspace/agent_decisions/large_segments_60m_api_allowed.decisions.normalized.jsonl`
