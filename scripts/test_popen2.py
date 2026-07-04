import subprocess, sys, os, json, tempfile, time

LLAMA = r"D:\files\qwen-chat\bin\llama-cli.exe"
MODEL = r"D:\files\qwen-chat\models\qwen2.5-0.5b-instruct-q4_k_m.gguf"
LORA = r"D:\files\qwen-chat\adapters\adapter.gguf"

fd, path = tempfile.mkstemp(suffix=".txt", prefix="qwen_", text=True)
with os.fdopen(fd, "w", encoding="utf-8") as f:
    f.write("<|im_start|>system\n你是廖建军<|im_end|>\n<|im_start|>user\n你是谁？<|im_end|>\n<|im_start|>assistant\n")

cmd = f'"{LLAMA}" -m "{MODEL}" --lora "{LORA}" -ngl 99 -mg 1 --temp 0.7 -n 100 --no-display-prompt -f "{path}"'
print("Running via cmd /c 2>&1...")
sys.stdout.flush()

proc = subprocess.Popen(
    f"cmd /c {cmd} 2>&1",
    stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
    shell=True
)
print(f"PID: {proc.pid}")
sys.stdout.flush()

try:
    out, _ = proc.communicate(timeout=90)
    text = out.decode("utf-8", errors="replace")
    print(f"Exit code: {proc.returncode}")
    print(f"Output ({len(text)} chars):")
    print(text[:2000])
except subprocess.TimeoutExpired:
    print("TIMEOUT - killing")
    proc.kill()
    out, _ = proc.communicate()
    print(out.decode("utf-8", errors="replace")[:500])
except Exception as e:
    print(f"Error: {e}")
finally:
    os.unlink(path)