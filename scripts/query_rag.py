import argparse
import json
import sqlite3
import urllib.request

import sqlite_vec

DEFAULT_DB = "D:/files/qwen-chat/workspace/07_rag_embedding/stores/qwen_persona_rag.sqlite"
DEFAULT_ENDPOINT = "http://127.0.0.1:8081/v1/embeddings"
EMBEDDING_DIM = 1024


def embed_text(text, endpoint):
    """Call llama-server to get embedding vector."""
    data = json.dumps({"model": "qwen3-embedding-0.6b", "input": text}).encode("utf-8")
    req = urllib.request.Request(endpoint, data=data, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        result = json.loads(resp.read())
    return result["data"][0]["embedding"]


def query_rag(query_text, db_path, endpoint, top_k):
    """Search RAG database for similar chunks."""
    conn = sqlite3.connect(db_path)
    conn.enable_load_extension(True)
    sqlite_vec.load(conn)

    # Embed the query
    vec = embed_text(query_text, endpoint)
    vec_blob = sqlite_vec.serialize_float32(vec)

    # ANN search via vec0 index (returns L2 distance; convert to cosine: cos_dist = l2^2/2)
    rows = conn.execute(
        """SELECT c.chunk_id, c.date, c.text,
                   v.distance * v.distance / 2.0 AS dist
            FROM (
                SELECT rowid, distance
                FROM vec_qwen3_0_6b
                WHERE embedding MATCH ?
                ORDER BY distance
                LIMIT ?
            ) v
            JOIN chunks c ON c.chunk_rowid = v.rowid
            ORDER BY dist""",
        (vec_blob, top_k)
    ).fetchall()

    conn.close()
    return rows


def main():
    parser = argparse.ArgumentParser(description="Query RAG vector database")
    parser.add_argument("--query", "-q", required=True, help="Query text")
    parser.add_argument("--db", default=DEFAULT_DB, help="Database path")
    parser.add_argument("--endpoint", default=DEFAULT_ENDPOINT, help="Embedding API endpoint")
    parser.add_argument("--top-k", "-k", type=int, default=5, help="Number of results")
    parser.add_argument("--json", action="store_true", help="Output as JSON")
    args = parser.parse_args()

    results = query_rag(args.query, args.db, args.endpoint, args.top_k)

    if args.json:
        out = []
        for chunk_id, date, text, dist in results:
            out.append({"chunk_id": chunk_id, "date": date, "text": text[:200], "distance": dist})
        print(json.dumps(out, ensure_ascii=False, indent=2))
    else:
        print("Query: %s" % args.query)
        print("Results: %d\n" % len(results))
        for i, (chunk_id, date, text, dist) in enumerate(results):
            print("--- #%d [distance=%.4f] %s ---" % (i + 1, dist, date))
            print(text[:300])
            print()


if __name__ == "__main__":
    main()
