import json
import sqlite3
import struct
import urllib.request
import sqlite_vec

db = r"D:\files\qwen-chat\workspace\07_rag_embedding\stores\qwen_persona_rag.sqlite"

def vec_to_blob(vec):
    return struct.pack("%df" % len(vec), *vec)

def embed_api(text):
    data = json.dumps({"model": "qwen3-embedding-0.6b", "input": text}).encode("utf-8")
    req = urllib.request.Request("https://api.futureppo.top/v1/embeddings",
        data=data, headers={"Content-Type": "application/json",
        "Authorization": "Bearer sk-EC3TPAMBM8BZ3daVrMZAIAZ2OtGOQcdJT7Ryq1q7UAIyNeic"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read())["data"][0]["embedding"]

conn = sqlite3.connect(db)
conn.enable_load_extension(True)
sqlite_vec.load(conn)

for q in ["你是不是去世了啊", "怎么沉默了啊", "nmsl", "你妈炸了", "今天吃什么"]:
    vec = embed_api(q)
    blob = vec_to_blob(vec)
    rows = conn.execute(
        """SELECT c.chunk_id, c.date, c.text,
                  vec_distance_cosine(v.embedding, ?) AS dist
           FROM vec_qwen3_0_6b v
           JOIN chunks c ON c.chunk_rowid = v.rowid
           ORDER BY dist LIMIT 3""",
        (blob,)
    ).fetchall()
    print("=== %s ===" % q)
    for i, (cid, date, text, dist) in enumerate(rows):
        print("  #%d [cos=%.4f] %s" % (i+1, dist, date))
        for line in text.strip().split("\n")[:2]:
            print("  %s" % line[:120])
        print()
conn.close()
