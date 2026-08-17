import json, sqlite3, struct, urllib.request
import sqlite_vec

db = r"D:\files\qwen-chat\workspace\07_rag_embedding\stores\qwen_persona_rag.sqlite"
conn = sqlite3.connect(db)
conn.enable_load_extension(True)
sqlite_vec.load(conn)

text = "你是不是去世了啊"
data = json.dumps({"model": "qwen3-embedding-0.6b", "input": text}).encode()
req = urllib.request.Request(
    "https://api.futureppo.top/v1/embeddings", data=data,
    headers={"Content-Type": "application/json",
             "Authorization": "Bearer [REDACTED]"})
resp = urllib.request.urlopen(req, timeout=15)
vec = json.loads(resp.read())["data"][0]["embedding"]
blob = struct.pack("%df" % len(vec), *vec)
rows = conn.execute(
    "SELECT c.chunk_id, c.date, c.text, vec_distance_cosine(v.embedding, ?) AS d "
    "FROM vec_qwen3_0_6b v JOIN chunks c ON c.chunk_rowid=v.rowid ORDER BY d LIMIT 3",
    (blob,)).fetchall()
print("Query:", text)
for i, (cid, date, text, dist) in enumerate(rows):
    print("#%d [cos=%.4f] %s" % (i+1, dist, date))
    for line in text.strip().split("\n")[:2]:
        print("  " + line[:120])
    print()
conn.close()
