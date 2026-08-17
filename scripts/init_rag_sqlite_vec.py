import argparse
import sqlite3
from pathlib import Path

import sqlite_vec


DEFAULT_DB = Path("workspace/07_rag_embedding/stores/qwen_persona_rag.sqlite")
EMBEDDING_DIM = 1024
DEFAULT_MODEL = "qwen3-embedding-0.6b"


SCHEMA = f"""
PRAGMA journal_mode=WAL;
PRAGMA synchronous=NORMAL;

CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS chunks (
    chunk_rowid INTEGER PRIMARY KEY AUTOINCREMENT,
    chunk_id TEXT NOT NULL UNIQUE,
    date TEXT NOT NULL,
    text TEXT NOT NULL,
    embed_text TEXT NOT NULL,
    text_hash TEXT NOT NULL UNIQUE,
    char_count INTEGER NOT NULL,
    message_count INTEGER NOT NULL,
    embedded_at TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_chunks_date ON chunks(date);
CREATE INDEX IF NOT EXISTS idx_chunks_text_hash ON chunks(text_hash);

CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
    chunk_id UNINDEXED,
    date UNINDEXED,
    text
);

CREATE TABLE IF NOT EXISTS embedding_jobs (
    job_id INTEGER PRIMARY KEY AUTOINCREMENT,
    chunk_id TEXT NOT NULL,
    text_hash TEXT NOT NULL,
    model TEXT NOT NULL,
    provider TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    priority INTEGER NOT NULL DEFAULT 100,
    attempts INTEGER NOT NULL DEFAULT 0,
    claimed_by TEXT,
    claimed_at TEXT,
    last_error TEXT,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(chunk_id, model, provider)
);

CREATE INDEX IF NOT EXISTS idx_embedding_jobs_status ON embedding_jobs(status, priority, job_id);
CREATE INDEX IF NOT EXISTS idx_embedding_jobs_chunk ON embedding_jobs(chunk_id);
CREATE INDEX IF NOT EXISTS idx_embedding_jobs_provider ON embedding_jobs(provider, status);

CREATE TABLE IF NOT EXISTS embedding_runs (
    run_id TEXT PRIMARY KEY,
    model TEXT NOT NULL,
    provider TEXT NOT NULL,
    endpoint TEXT,
    dim INTEGER NOT NULL,
    batch_size INTEGER,
    worker_id TEXT,
    started_at TEXT DEFAULT CURRENT_TIMESTAMP,
    finished_at TEXT,
    status TEXT NOT NULL DEFAULT 'running',
    stats_json TEXT
);
"""


def connect(db_path: Path) -> sqlite3.Connection:
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(db_path)
    conn.enable_load_extension(True)
    sqlite_vec.load(conn)
    return conn


def init_db(db_path: Path, force: bool) -> None:
    if force and db_path.exists():
        db_path.unlink()

    conn = connect(db_path)
    try:
        conn.executescript(SCHEMA)
        conn.execute(
            f"CREATE VIRTUAL TABLE IF NOT EXISTS vec_qwen3_0_6b USING vec0(embedding float[{EMBEDDING_DIM}])"
        )
        conn.execute("INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)", ("schema_version", "2"))
        conn.execute("INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)", ("embedding_dim", str(EMBEDDING_DIM)))
        conn.execute("INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)", ("default_embedding_model", DEFAULT_MODEL))
        conn.execute(
            "INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)",
            ("embedding_text_format", "date: YYYY-MM-DD\\n\\nuser/assistant chat text"),
        )
        conn.commit()
    finally:
        conn.close()


def main() -> None:
    parser = argparse.ArgumentParser(description="Initialize the local RAG SQLite/sqlite-vec database.")
    parser.add_argument("--db", type=Path, default=DEFAULT_DB)
    parser.add_argument("--force", action="store_true", help="Delete and recreate the database.")
    args = parser.parse_args()

    init_db(args.db, args.force)
    print(f"initialized: {args.db}")


if __name__ == "__main__":
    main()
