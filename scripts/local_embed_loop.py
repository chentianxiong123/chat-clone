"""Local embedding loop: start llama-server, run 100 items, kill server, repeat."""
import json
import sqlite3
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

PROJECT = Path(__file__).resolve().parent.parent
WORKER = PROJECT / "scripts" / "embed_worker_sqlite_vec.py"
SERVER = r"D:\llama-lora-embed\build\bin\Release\llama-server.exe"
MODEL = r"D:\models\qwen3-embedding-0.6b-q8_0.gguf"
ENDPOINT = "http://127.0.0.1:8081/v1/embeddings"
DB = PROJECT / "workspace/07_rag_embedding/stores/qwen_persona_rag.sqlite"
BATCH_PER_ROUND = 100
SERVER_READY_TIMEOUT = 60


def get_counts() -> tuple:
    conn = sqlite3.connect(str(DB))
    rows = conn.execute("SELECT status, count(*) FROM embedding_jobs GROUP BY status").fetchall()
    conn.close()
    d = dict(rows)
    return d.get("done", 0), d.get("pending", 0), d.get("failed", 0)


def start_server() -> subprocess.Popen:
    return subprocess.Popen(
        [SERVER, "-m", MODEL, "--embedding", "--host", "127.0.0.1", "--port", "8081",
         "-ngl", "99", "-c", "4096", "-b", "512", "-ub", "512",
         "--pooling", "last", "--embd-normalize", "2", "--no-mmap"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )


def wait_ready(timeout: int = SERVER_READY_TIMEOUT) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            body = json.dumps({"model": "qwen3-embedding-0.6b", "input": "ok"}).encode()
            req = urllib.request.Request(ENDPOINT, data=body, method="POST",
                                        headers={"Content-Type": "application/json"})
            with urllib.request.urlopen(req, timeout=10) as resp:
                if resp.status == 200:
                    return True
        except Exception:
            pass
        time.sleep(2)
    return False


def kill_server(proc: subprocess.Popen) -> None:
    try:
        proc.kill()
        proc.wait(timeout=5)
    except Exception:
        try:
            proc.terminate()
            proc.wait(timeout=5)
        except Exception:
            pass


def run_worker() -> int:
    cmd = [
        sys.executable, str(WORKER),
        "--provider", "local", "--model", "qwen3-embedding-0.6b",
        "--endpoint", ENDPOINT, "--claim-any-provider", "--claim-any-model",
        "--limit", str(BATCH_PER_ROUND), "--batch-size", "1", "--timeout", "300",
    ]
    proc = subprocess.Popen(cmd, cwd=str(PROJECT))
    proc.wait()
    return proc.returncode


def main() -> None:
    round_num = 0
    while True:
        round_num += 1
        t0 = time.time()
        done, pending, failed = get_counts()
        print(f"[round {round_num}] done={done} pending={pending} failed={failed}", flush=True)
        if pending == 0:
            print(f"\n=== ALL DONE in {round_num} rounds ===", flush=True)
            break
        srv = start_server()
        print(f"  server pid={srv.pid}, waiting...", flush=True)
        if not wait_ready():
            print("  server failed, retrying...", flush=True)
            kill_server(srv)
            time.sleep(5)
            continue
        print(f"  worker running {BATCH_PER_ROUND} items...", flush=True)
        run_worker()
        elapsed = time.time() - t0
        kill_server(srv)
        time.sleep(3)
        done2, pending2, failed2 = get_counts()
        print(f"  round done in {elapsed:.1f}s -> done={done2} pending={pending2} failed={failed2}\n", flush=True)
    done, pending, failed = get_counts()
    print(f"Final: done={done} pending={pending} failed={failed}", flush=True)


if __name__ == "__main__":
    main()
