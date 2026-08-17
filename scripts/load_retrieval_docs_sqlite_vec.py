import argparse
import json
import sqlite3
from pathlib import Path

import sqlite_vec


DEFAULT_INPUT = Path("workspace/07_rag_embedding/retrieval_docs/retrieval_docs_v1.jsonl")
DEFAULT_DB = Path("workspace/07_rag_embedding/stores/qwen_persona_rag.sqlite")
DEFAULT_MODEL = "qwen3-embedding-0.6b"
DEFAULT_PROVIDER = "local"


def connect(db_path: Path) -> sqlite3.Connection:
    conn = sqlite3.connect(db_path)
    conn.enable_load_extension(True)
    sqlite_vec.load(conn)
    return conn


def load_docs(input_path: Path, db_path: Path, model: str, provider: str, limit: int) -> dict:
    conn = connect(db_path)
    stats = {
        "input": str(input_path),
        "db": str(db_path),
        "read": 0,
        "chunks_inserted": 0,
        "chunks_existing": 0,
        "jobs_inserted": 0,
        "jobs_existing": 0,
    }
    try:
        with input_path.open("r", encoding="utf-8") as f:
            for line in f:
                if limit and stats["read"] >= limit:
                    break
                if not line.strip():
                    continue
                row = json.loads(line)
                stats["read"] += 1
                cur = conn.execute(
                    """
                    INSERT OR IGNORE INTO chunks(
                        chunk_id, date, text, embed_text, text_hash, char_count, message_count
                    ) VALUES (?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        row["chunk_id"],
                        row["date"],
                        row["text"],
                        row["embed_text"],
                        row["text_hash"],
                        row["char_count"],
                        row["message_count"],
                    ),
                )
                if cur.rowcount:
                    stats["chunks_inserted"] += 1
                    conn.execute(
                        "INSERT INTO chunks_fts(chunk_id, date, text) VALUES (?, ?, ?)",
                        (row["chunk_id"], row["date"], row["text"]),
                    )
                else:
                    stats["chunks_existing"] += 1

                cur = conn.execute(
                    """
                    INSERT OR IGNORE INTO embedding_jobs(chunk_id, text_hash, model, provider)
                    VALUES (?, ?, ?, ?)
                    """,
                    (row["chunk_id"], row["text_hash"], model, provider),
                )
                if cur.rowcount:
                    stats["jobs_inserted"] += 1
                else:
                    stats["jobs_existing"] += 1
        conn.commit()
    finally:
        conn.close()
    return stats


def main() -> None:
    parser = argparse.ArgumentParser(description="Load retrieval docs into SQLite and enqueue embedding jobs.")
    parser.add_argument("--input", type=Path, default=DEFAULT_INPUT)
    parser.add_argument("--db", type=Path, default=DEFAULT_DB)
    parser.add_argument("--model", default=DEFAULT_MODEL)
    parser.add_argument("--provider", default=DEFAULT_PROVIDER)
    parser.add_argument("--limit", type=int, default=0)
    args = parser.parse_args()

    print(json.dumps(load_docs(args.input, args.db, args.model, args.provider, args.limit), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
