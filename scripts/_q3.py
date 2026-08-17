import json,sqlite3,struct,urllib.request,sqlite_vec
db=r"D:\files\qwen-chat\workspace\07_rag_embedding\stores\qwen_persona_rag.sqlite"
conn=sqlite3.connect(db);conn.enable_load_extension(True);sqlite_vec.load(conn)
def embed(t):
    d=json.dumps({"model":"qwen3-embedding-0.6b","input":t}).encode()
    r=urllib.request.Request("https://api.futureppo.top/v1/embeddings",data=d,headers={"Content-Type":"application/json","Authorization":"Bearer [REDACTED]"})
    return json.loads(urllib.request.urlopen(r,timeout=15).read())["data"][0]["embedding"]
for q in ["晚上吃什么","好无聊啊","卧槽真的假的"]:
    try:
        v=embed(q);b=struct.pack("%df"%len(v),*v)
        rs=conn.execute("SELECT c.date,c.text,vec_distance_cosine(v.embedding,?)d FROM vec_qwen3_0_6b v JOIN chunks c ON c.chunk_rowid=v.rowid ORDER BY d LIMIT 2",(b,)).fetchall()
        print("===%s===" % q)
        for date,text,dist in rs: print("[%.3f]%s %s" % (dist,date,text.strip().split(chr(10))[0][:80]))
    except Exception as e: print("===%s=== ERROR:%s" % (q,e))
    print()
conn.close()
