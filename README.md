# Qwen-Chat RX580

Local tooling for experimenting with chat-record cleaning, agent-assisted segmentation, lightweight SFT dataset construction, and RAG preparation on AMD RX580/RX590-class hardware.

The repository is intended to contain only release-safe code and workflow documentation. Raw chat exports, generated datasets, model weights, LoRA adapters, compiled binaries, local queues, and private workspaces are ignored by Git.

## What Is Included

- `scripts/`: data extraction helpers, segmentation builders, queue utilities, SFT dataset builders, and normalization scripts.
- `config/` and `configs/`: review policy and training configuration templates.
- `docs/`: project workflow notes.
- `.gitignore`: protects private data, model files, local environments, compiled binaries, and generated outputs.

## Private Paths

Keep these local only:

- `raw/`
- `chat_records/`
- `data/`
- `workspace/`
- `models/`
- `adapters/`
- `bin/`
- `qq-env/`
- `llama-server-src/`

## Core Pipeline

1. Export or normalize source chat records into JSONL.
2. Build 60-minute container sessions.
3. Route API-safe and manual-review content separately.
4. Build resumable agent jobs for boundary decisions.
5. Merge agent decisions into final segments.
6. Build short SFT datasets or RAG ingestion inputs from the approved segments.

The current direction favors RAG and retrieval-augmented behavior over relying on a small LoRA model to learn long-range personality logic.

## Hardware Target

The scripts and notes are designed around low-cost local experimentation with:

- AMD RX580 / RX590-class 8GB GPUs
- Vulkan llama.cpp builds
- Qwen/Qwen2.5 small models
- Qwen embedding models for local retrieval

## Privacy Rule

Do not commit private chats, real-person identifiers, model weights, generated training files, queue artifacts, database files, API keys, or local binary packages.
