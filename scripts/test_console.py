import subprocess, sys, os, json, tempfile, time

fd, path = tempfile.mkstemp(suffix=".txt", prefix="qwen_", text=True)
with os.fdopen(fd, "w", encoding="utf-8") as f:
    f.write("<|im_start|>system\n你是廖建军<|im_end|>\n<|im_start|>user\n你是谁？<|im_end|>\n<|im_start|>assistant\n")

LLAMA = r"D:\files\qwen-chat\bin\llama-cli.exe"
MODEL = r"D:\files\qwen-chat\models\qwen2.5-0.5b-instruct-q4_k_m.gguf"
LORA = r"D:\files\qwen-chat\adapters\adapter.gguf"

args = [
    LLAMA, "-m", MODEL, "--lora", LORA,
    "-ngl", "99", "-mg", "1", "--temp", "0.7",
    "-n", "100", "--no-display-prompt", "-f", path
]

sys.stdout.flush()
proc = subprocess.Popen(
    args,
    stdin=subprocess.DEVNULL,
    stdout=subprocess.PIPE,
    stderr=subprocess.STDOUT,
    creationflags=subprocess.CREATE_NEW_CONSOLE
)
print(f"PID: {proc.pid}")
sys.stdout.flush()

time.sleep(30)
poll = proc.poll()
print(f"After 30s - poll: {poll}")
if poll is not None:
    out = proc.stdout.read()
    print(f"Output ({len(out)} bytes): {out.decode('utf-8', errors='replace')[:2000]}")
else:
    print("Still running, terminating...")
    proc.terminate()
    time.sleep(3)
    if proc.poll() is None:
        proc.kill()
    out = b""
    try:
        out = proc.stdout.read()
    except Exception as e:
        print(f"Read error: {e}")
    print(f"Output after kill: {out.decode('utf-8', errors='replace')[:500]}")

os.unlink(path)