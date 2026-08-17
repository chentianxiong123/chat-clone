import argparse
import os
import json
import sqlite3
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path

import sqlite_vec


DEFAULT_DB = Path("workspace/07_rag_embedding/stores/qwen_persona_rag.sqlite")
DEFAULT_MODEL = "qwen3-embedding-0.6b"
DEFAULT_PROVIDER = "local"
DEFAULT_ENDPOINT = "http://127.0.0.1:8081/v1/embeddings"
EMBEDDING_DIM = 1024


def connect(db_path: Path) -> sqlite3.Connection:
    conn = sqlite3.connect(db_path, timeout=30)
    conn.enable_load_extension(True)
    sqlite_vec.load(conn)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    return conn


def claim_jobs(
    conn: sqlite3.Connection,
    provider: str,
    model: str,
    worker_id: str,
    batch_size: int,
    claim_any_provider: bool,
    claim_any_model: bool,
) -> list[dict]:
    provider_filter = "" if claim_any_provider else "AND j.provider = ?"
    model_filter = "" if claim_any_model else "AND j.model = ?"
    params = []
    if not claim_any_model:
        params.append(model)
    if not claim_any_provider:
        params.append(provider)
    params.append(batch_size)
    conn.execute("BEGIN IMMEDIATE")
    try:
        rows = conn.execute(
            f"""
            SELECT j.job_id
            FROM embedding_jobs j
            WHERE j.status = 'pending'
              {model_filter}
              {provider_filter}
            ORDER BY j.priority, j.job_id
            LIMIT ?
            """,
            params,
        ).fetchall()
        if not rows:
            conn.commit()
            return []

        job_ids = [row[0] for row in rows]
        placeholders = ",".join("?" for _ in job_ids)
        conn.execute(
            f"""
            UPDATE embedding_jobs
            SET status = 'claimed',
                provider = ?,
                model = ?,
                claimed_by = ?,
                claimed_at = CURRENT_TIMESTAMP,
                updated_at = CURRENT_TIMESTAMP
            WHERE status = 'pending'
              AND job_id IN ({placeholders})
            """,
            [provider, model, worker_id, *job_ids],
        )
        claimed = conn.execute(
            """
            SELECT j.job_id, j.chunk_id, c.embed_text
            FROM embedding_jobs j
            JOIN chunks c ON c.chunk_id = j.chunk_id
            WHERE j.status = 'claimed'
              AND j.claimed_by = ?
            ORDER BY j.priority, j.job_id
            """,
            (worker_id,),
        ).fetchall()
        conn.commit()
        return [{"job_id": row[0], "chunk_id": row[1], "embed_text": row[2]} for row in claimed]
    except Exception:
        conn.rollback()
        raise


def release_jobs(conn: sqlite3.Connection, jobs: list[dict], error: str) -> None:
    for job in jobs:
        conn.execute(
            """
            UPDATE embedding_jobs
            SET status = CASE WHEN attempts + 1 >= 3 THEN 'failed' ELSE 'pending' END,
                attempts = attempts + 1,
                last_error = ?,
                claimed_by = NULL,
                claimed_at = NULL,
                updated_at = CURRENT_TIMESTAMP
            WHERE job_id = ?
            """,
            (error[:1000], job["job_id"]),
        )
    conn.commit()


def request_embeddings(endpoint: str, model: str, texts: list[str], timeout: int, api_key: str | None) -> list[list[float]]:
    body = json.dumps({"model": model, "input": texts}, ensure_ascii=False).encode("utf-8")
    headers = {"Content-Type": "application/json", "User-Agent": "Mozilla/5.0"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    req = urllib.request.Request(endpoint, data=body, headers=headers, method="POST")
    proxy_url = os.environ.get("HTTPS_PROXY") or os.environ.get("https_proxy")
    if proxy_url:
        proxy_handler = urllib.request.ProxyHandler({"https": proxy_url})
        opener = urllib.request.build_opener(proxy_handler)
    else:
        opener = urllib.request.build_opener()
    with opener.open(req, timeout=timeout) as resp:
        payload = json.loads(resp.read().decode("utf-8"))
    data = sorted(payload["data"], key=lambda item: item.get("index", 0))
    return [item["embedding"] for item in data]


def write_embeddings(conn: sqlite3.Connection, jobs: list[dict], embeddings: list[list[float]]) -> None:
    if len(jobs) != len(embeddings):
        raise ValueError(f"embedding count mismatch: jobs={len(jobs)} embeddings={len(embeddings)}")
    for job, embedding in zip(jobs, embeddings):
        if len(embedding) != EMBEDDING_DIM:
            raise ValueError(f"unexpected embedding dim for {job['chunk_id']}: {len(embedding)}")
        rowid = conn.execute("SELECT chunk_rowid FROM chunks WHERE chunk_id = ?", (job["chunk_id"],)).fetchone()
        if not rowid:
            raise ValueError(f"missing chunk: {job['chunk_id']}")
        conn.execute(
            "INSERT OR REPLACE INTO vec_qwen3_0_6b(rowid, embedding) VALUES (?, ?)",
            (rowid[0], sqlite_vec.serialize_float32(embedding)),
        )
        conn.execute("UPDATE chunks SET embedded_at = CURRENT_TIMESTAMP WHERE chunk_id = ?", (job["chunk_id"],))
        conn.execute(
            """
            UPDATE embedding_jobs
            SET status = 'done',
                attempts = attempts + 1,
                last_error = NULL,
                claimed_by = NULL,
                claimed_at = NULL,
                updated_at = CURRENT_TIMESTAMP
            WHERE job_id = ?
            """,
            (job["job_id"],),
        )
    conn.commit()


def status_counts(conn: sqlite3.Connection) -> dict:
    rows = conn.execute(
        "SELECT provider, status, count(*) FROM embedding_jobs GROUP BY provider, status ORDER BY provider, status"
    ).fetchall()
    return {f"{provider}:{status}": count for provider, status, count in rows}


def run_worker(args: argparse.Namespace) -> dict:
    worker_id = args.worker_id or f"{args.provider}-{uuid.uuid4().hex[:8]}"
    api_key = args.api_key or (os.environ.get(args.api_key_env) if args.api_key_env else None)
    run_id = uuid.uuid4().hex
    conn = connect(args.db)
    stats = {"worker_id": worker_id, "run_id": run_id, "batches": 0, "embedded": 0, "errors": 0}
    started = time.time()
    try:
        conn.execute(
            """
            INSERT INTO embedding_runs(run_id, model, provider, endpoint, dim, batch_size, worker_id)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (run_id, args.model, args.provider, args.endpoint, EMBEDDING_DIM, args.batch_size, worker_id),
        )
        conn.commit()

        while True:
            remaining = args.limit - stats["embedded"] if args.limit else args.batch_size
            if args.limit and remaining <= 0:
                break
            jobs = claim_jobs(
                conn,
                args.provider,
                args.model,
                worker_id,
                min(args.batch_size, remaining),
                args.claim_any_provider,
                args.claim_any_model,
            )
            if not jobs:
                break
            try:
                t0 = time.time()
                embeddings = request_embeddings(
                    args.endpoint,
                    args.model,
                    [job["embed_text"] for job in jobs],
                    args.timeout,
                    api_key,
                )
                write_embeddings(conn, jobs, embeddings)
                stats["batches"] += 1
                stats["embedded"] += len(jobs)
                elapsed = max(time.time() - t0, 0.001)
                print(
                    json.dumps(
                        {
                            "batch": stats["batches"],
                            "embedded": len(jobs),
                            "seconds": round(elapsed, 3),
                            "items_per_second": round(len(jobs) / elapsed, 3),
                        },
                        ensure_ascii=False,
                    )
                )
            except Exception as exc:
                stats["errors"] += 1
                release_jobs(conn, jobs, repr(exc))
                if args.stop_on_error:
                    raise
                time.sleep(args.sleep_on_error)

        status = "complete" if stats["errors"] == 0 else "complete_with_errors"
        stats["seconds"] = round(time.time() - started, 3)
        stats["status_counts"] = status_counts(conn)
        conn.execute(
            """
            UPDATE embedding_runs
            SET finished_at = CURRENT_TIMESTAMP,
                status = ?,
                stats_json = ?
            WHERE run_id = ?
            """,
            (status, json.dumps(stats, ensure_ascii=False), run_id),
        )
        conn.commit()
        return stats
    finally:
        conn.close()


def main() -> None:
    parser = argparse.ArgumentParser(description="Non-blocking SQLite/sqlite-vec embedding worker.")
    parser.add_argument("--db", type=Path, default=DEFAULT_DB)
    parser.add_argument("--provider", default=DEFAULT_PROVIDER)
    parser.add_argument("--model", default=DEFAULT_MODEL)
    parser.add_argument("--endpoint", default=DEFAULT_ENDPOINT)
    parser.add_argument("--api-key")
    parser.add_argument("--api-key-env")
    parser.add_argument("--claim-any-provider", action="store_true")
    parser.add_argument("--claim-any-model", action="store_true")
    parser.add_argument("--batch-size", type=int, default=1)
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--timeout", type=int, default=120)
    parser.add_argument("--worker-id")
    parser.add_argument("--stop-on-error", action="store_true")
    parser.add_argument("--sleep-on-error", type=float, default=2.0)
    args = parser.parse_args()
    print(json.dumps(run_worker(args), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
