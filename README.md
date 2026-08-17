# chat-clone

Build a Qwen-based chat persona agent on low-cost AMD GPUs via RAG and LoRA fine-tuning.

Local tooling covering the full pipeline: chat-record extraction (WeChat/QQ), cleaning, agent-assisted segmentation, RAG embedding pipeline, SFT/LoRA dataset construction, and Q-LoRA fine-tuning on RX580/RX590-class 8GB hardware.

The repository contains only release-safe code and workflow documentation. Raw chat exports, generated datasets, model weights, LoRA adapters, compiled binaries, local queues, and private workspaces are ignored by Git.

## Repository Role

This is the downstream persona-agent and data workflow repository.

```text
ggerganov/llama.cpp
        ↓ upstream sync
chentianxiong123/llama.cpp-lora-embed
        ↓ runtime dependency (Qwen inference, LoRA, Q-LoRA, embedding API)
chentianxiong123/chat-clone
        ↓ this repo (chat processing, RAG, SFT, persona pipeline)
```

Use `llama.cpp-lora-embed` for the local runtime: Qwen inference, LoRA loading, Q-LoRA experiments, and OpenAI-compatible embedding service. Use this repository for private chat processing, segment review, retrieval documents, SFT/RAG dataset construction, and persona-agent workflow scripts.

## Core Pipeline

```text
chat_records/                      ← source: WeChat 3.x + QQ 9.x JSONL
  → 01_sessions_60m/               ← 60-minute session bucketing
  → 02_policy_route_sensitive_split/ ← API-safe / blocked routing
  → 03_agent_split_jobs/            ← agent job construction
  → 04_ai_batch_workspaces/         ← Claude API batch processing
  → 05_agent_decisions/             ← merged & normalized decisions
  → 06_final_segments/              ← final chat segments
  → 07_rag_embedding/               ← retrieval docs + sqlite-vec store
  → 08_sft_datasets/                ← SFT training data
  → 09_train_runs/                  ← LoRA / Q-LoRA training
```

The current direction favors **RAG and retrieval-augmented behavior** over relying on a small LoRA model to learn long-range personality logic. See `docs/embedding_production.md` for the embedding pipeline shape.

## Stack

| Layer | Technology |
|-------|-----------|
| **Model** | Qwen / Qwen2.5 small models |
| **Embedding** | Qwen embedding model (e.g. qwen3-embedding-0.6b, 1024-dim) |
| **Runtime** | llama.cpp Vulkan build (via `llama.cpp-lora-embed`) |
| **GPU** | AMD RX580 / RX590-class 8GB (Vulkan) |
| **Vector DB** | sqlite-vec (local, no server) |
| **Fine-tuning** | Q-LoRA via `llama-finetune-qlora` |
| **Data Source** | WeChat 3.x (SQLCipher) + QQ 9.x (TEA/Frida) |

## What Is Included

- `scripts/`: data extraction helpers, segmentation builders, queue utilities, SFT dataset builders, embedding worker, and normalization scripts.
- `config/` and `configs/`: review policy and training configuration templates.
- `docs/`: project workflow notes, embedding production, concurrent guide.
- `chat_records/docs/GUIDE.md`: WeChat/QQ extraction technical guide.
- `.gitignore`: protects private data, model files, local environments, compiled binaries, and generated outputs.

## Key Artifacts (Private, Not in Git)

| Path | Description |
|------|-------------|
| `chat_records/` | Raw WeChat & QQ JSONL exports |
| `workspace/05_agent_decisions/` | Claude API segment decisions |
| `workspace/06_final_segments/` | Final chat segments (RAG source) |
| `workspace/07_rag_embedding/stores/qwen_persona_rag.sqlite` | sqlite-vec store (~181MB, 17,846 chunks, 1024-dim) |
| `adapters/` | Trained LoRA adapters (`.gguf`) |
| `bin/` | llama.cpp Vulkan binaries |

## Extraction Note

Chat records are extracted from Windows WeChat 3.x and QQ 9.x using:

- **WeChat**: SQLCipher 3 decryption via `search_wechat_key` + `pywxdump`
- **QQ**: TEA key extraction via Frida hook, Msg3.0.db decryption, double-layer TLV parsing

See `chat_records/docs/GUIDE.md` for the full technical reference.

## Privacy Rule

Do not commit private chats, real-person identifiers, model weights, generated training files, queue artifacts, database files, API keys, or local binary packages.
