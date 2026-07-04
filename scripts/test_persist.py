import subprocess, sys, os, json, time, urllib.request

proc = subprocess.Popen(
    [sys.executable, os.path.join(os.path.dirname(__file__), "api_server.py")],
    stdout=subprocess.PIPE, stderr=subprocess.PIPE
)
time.sleep(3)

try:
    data = json.dumps({
        "messages": [
            {"role": "user", "content": "你好"}
        ],
        "max_tokens": 100,
        "temperature": 0.7
    }).encode()

    req = urllib.request.Request("http://localhost:8080", data=data,
                                 headers={"Content-Type": "application/json"})
    resp = urllib.request.urlopen(req, timeout=180)
    result = json.loads(resp.read())
    print(json.dumps(result, ensure_ascii=False, indent=2))
except Exception as e:
    print(f"Error: {e}")
finally:
    proc.terminate()
    proc.wait()
    # Print stderr for debugging
    out = proc.stdout.read().decode("utf-8", errors="replace")
    err = proc.stderr.read().decode("utf-8", errors="replace")
    if out.strip():
        print(f"\nStdout: {out[:500]}")
    if err.strip():
        print(f"\nStderr: {err[:500]}")