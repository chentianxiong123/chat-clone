import json, sqlite3, struct, urllib.request
import sqlite_vec

db = r"D:\files\qwen-chat\workspace\07_rag_embedding\stores\qwen_persona_rag.sqlite"
conn = sqlite3.connect(db)
conn.enable_load_extension(True)
sqlite_vec.load(conn)

def embed(text):
    data = json.dumps({"model": "qwen3-embedding-0.6b", "input": text}).encode()
    req = urllib.request.Request(
        "https://api.futureppo.top/v1/embeddings", data=data,
        headers={"Content-Type": "application/json",
                 "Authorization": "Bearer [REDACTED]"})
    resp = urllib.request.urlopen(req, timeout=20)
    return json.loads(resp.read())["data"][0]["embedding"]

def search(query, k=3):
    vec = embed(query)
    blob = struct.pack("%df" % len(vec), *vec)
    return conn.execute(
        "SELECT c.chunk_id, c.date, c.text, vec_distance_cosine(v.embedding, ?) AS d "
        "FROM vec_qwen3_0_6b v JOIN chunks c ON c.chunk_rowid=v.rowid ORDER BY d LIMIT ?",
        (blob, k)).fetchall()

queries = [
    "晚上吃什么",
    "你觉得这个怎么样",
    "好无聊啊",
    "帮我看看这个bug",
    "最近在忙什么",
    "生日快乐",
    "你那个游戏打到哪了",
    "明天几点出门",
    "你觉得他这个人怎么样",
    "卧槽真的假的",
]

for q in queries:
    print("=== %s ===" % q)
    try:
        rows = search(q, 3)
        for i, (cid, date, text, dist) in enumerate(rows):
            first_line = text.strip().split("\n")[0][:100]
            print("  #%d [%.3f] %s | %s" % (i+1, dist, date, first_line))
    except Exception as e:
        print("  ERROR: %s" % e)
    print()

conn.close()
