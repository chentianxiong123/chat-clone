import http.server
import json
import subprocess
import tempfile
import os
import time
import re
import traceback

LLAMA = r"D:\files\qwen-chat\bin\llama-cli.exe"
MODEL = r"D:\files\qwen-chat\models\qwen2.5-0.5b-instruct-q4_k_m.gguf"
HOST = "0.0.0.0"
PORT = 8080

def generate(messages, max_tokens=200, temp=0.7):
    prompt = ""
    for m in messages:
        prompt += f"<|im_start|>{m['role']}\n{m['content']}<|im_end|>\n"
    prompt += "<|im_start|>assistant\n"

    fd, path = tempfile.mkstemp(suffix=".txt", prefix="qwen_", text=True)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(prompt)

        args = [
            LLAMA, "-m", MODEL,
            "-ngl", "99", "-mg", "1",
            "--temp", str(temp), "-n", str(max_tokens),
            "--no-display-prompt", "-f", path
        ]
        proc = subprocess.Popen(
            args, stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            creationflags=subprocess.CREATE_NO_WINDOW
        )
        out, _ = proc.communicate(timeout=120)
        return extract(out.decode("utf-8", errors="replace"))
    except subprocess.TimeoutExpired:
        proc.kill()
        return "Error: timeout"
    finally:
        try: os.unlink(path)
        except: pass

def extract(text):
    text = re.compile(r'\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])').sub('', text)
    collecting = False
    result = []
    for line in text.split("\n"):
        s = line.strip()
        if not s: continue
        if not collecting:
            if "<|im_start|>assistant" in s: collecting = True
            continue
        if s.startswith("[") and "t/s" in s: continue
        if s.startswith(">") or "<|im_end|>" in s: continue
        if s.startswith("Exiting") or "GGML_ASSERT" in s: continue
        if s.startswith("build") or s.startswith("model"): continue
        result.append(s)
    return "\n".join(result).strip()

class Handler(http.server.BaseHTTPRequestHandler):
    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_POST(self):
        t0 = time.time()
        try:
            length = int(self.headers.get("Content-Length", 0))
            body = json.loads(self.rfile.read(length))
            content = generate(body.get("messages", []),
                               body.get("max_tokens", 200),
                               body.get("temperature", 0.7))
            resp = {
                "id": "chatcmpl-" + str(int(time.time())),
                "object": "chat.completion",
                "created": int(time.time()),
                "model": "qwen2.5-0.5b",
                "choices": [{"index": 0, "message": {"role": "assistant", "content": content}, "finish_reason": "stop"}]
            }
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(json.dumps(resp, ensure_ascii=False).encode("utf-8"))
            print(f"[{time.strftime('%H:%M:%S')}] {time.time()-t0:.1f}s | {len(content)} chars")
        except Exception as e:
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(json.dumps({"choices":[{"message":{"role":"assistant","content":f"Error: {e}"}}]}).encode("utf-8"))

    def do_GET(self):
        self.send_response(200)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.end_headers()
        self.wfile.write(b"Qwen API running. POST / with JSON body.")

if __name__ == "__main__":
    print(f"API at http://{HOST}:{PORT}")
    print(f"POST JSON with messages array to /")
    http.server.HTTPServer((HOST, PORT), Handler).serve_forever()