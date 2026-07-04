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

# Close stdin immediately so process doesn't wait for input
sys.stdout.flush()
proc = subprocess.Popen(
    args,
    stdin=subprocess.DEVNULL,
    stdout=subprocess.PIPE,
    stderr=subprocess.STDOUT,
)
print(f"PID: {proc.pid}")
sys.stdout.flush()

try:
    out, _ = proc.communicate(timeout=90)
    text = out.decode("utf-8", errors="replace")
    print(f"Exit code: {proc.returncode}, Output ({len(text)} chars):")
    print(text[:3000])
except subprocess.TimeoutExpired:
    print("TIMEOUT - killing")
    proc.kill()
    out, _ = proc.communicate()
    print(f"after kill: {out.decode('utf-8', errors='replace')[:1000]}")
except Exception as e:
    print(f"Error: {e}")
finally:
    os.unlink(path)