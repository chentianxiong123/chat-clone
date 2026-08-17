# Embedding Production Notes

This project should keep embedding production as explicit CLI steps instead of a hidden all-in-one workflow.

## Goal

Build reusable retrieval assets from approved chat segments:

1. Read reviewed segment JSONL.
2. Convert each segment into a stable retrieval document.
3. Generate embeddings with a selected Qwen embedding model.
4. Save vectors and metadata into a local ignored output path.
5. Build or refresh a local retrieval index.

The embedding runtime should come from `llama.cpp-lora-embed`, usually by starting `llama-server --embedding` with a Qwen embedding GGUF model. This repository should consume that API and manage data preparation, metadata, and retrieval indexes.

## Expected Inputs

- Approved segment JSONL, usually under `workspace/06_final_segments/`.
- Embedding model path under `models/`.
- Optional run configuration under local env vars or ignored workspace files.

## Expected Outputs

All production outputs are local artifacts and must stay out of Git:

- Raw embedding responses: `*_vec.json`
- Vector arrays: `*.npy`, `*.npz`
- Vector indexes: `*.faiss`
- Local databases: `*.sqlite`, `*.sqlite3`, `*.db`, `*.duckdb`
- Columnar exports: `*.parquet`, `*.arrow`

## CLI Shape

Keep future scripts callable by stage:

- `build_retrieval_docs`: segment JSONL to retrieval-document JSONL under `workspace/07_rag_embedding/`.
- `embed_docs`: retrieval-document JSONL to vectors plus metadata.
- `build_index`: vectors plus metadata to a searchable local index.
- `query_index`: query text to ranked retrieved segments.

Each stage should accept explicit `--input`, `--output`, and model/index parameters.

## Privacy Rule

Do not commit private chat text, real-person identifiers, generated vectors, local indexes, model weights, adapters, binaries, or API credentials.
