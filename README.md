# chat-clone

Local tooling for building a chat persona clone via RAG and LoRA, including chat-record cleaning, agent-assisted segmentation, dataset construction, and embedding pipeline.

The repository is intended to contain only release-safe code and workflow documentation. Raw chat exports, generated datasets, model weights, LoRA adapters, compiled binaries, local queues, and private workspaces are ignored by Git.

## Repository Role

This is the downstream persona-agent and data workflow repository.

```text
ggerganov/llama.cpp
        ↓ upstream sync
chentianxiong123/llama.cpp-lora-embed
        ↓ runtime dependency
chentianxiong123/chat-clone
```

Use `llama.cpp-lora-embed` for the local runtime: Qwen inference, LoRA loading, Q-LoRA experiments, and OpenAI-compatible embedding service. Use this repository for private chat processing, segment review, retrieval documents, SFT/RAG dataset construction, and persona-agent workflow scripts.

## What Is Included

- `scripts/`: data extraction helpers, segmentation builders, queue utilities, SFT dataset builders, and normalization scripts.
- `config/` and `configs/`: review policy and training configuration templates.
- `docs/`: project workflow notes, including embedding production notes.
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
7. Run embedding production as explicit CLI stages: retrieval docs, embeddings, index, query test.

The current direction favors RAG and retrieval-augmented behavior over relying on a small LoRA model to learn long-range personality logic.
See `docs/embedding_production.md` for the intended embedding production shape.

## Hardware Target

The scripts and notes are designed around low-cost local experimentation with:

- AMD RX580 / RX590-class 8GB GPUs
- Vulkan builds from `llama.cpp-lora-embed`
- Qwen/Qwen2.5 small models
- Qwen embedding models for local retrieval

## Privacy Rule

Do not commit private chats, real-person identifiers, model weights, generated training files, queue artifacts, database files, API keys, or local binary packages.
