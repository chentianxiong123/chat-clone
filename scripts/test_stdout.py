import subprocess, sys, os, json, tempfile, time

fd, path = tempfile.mkstemp(suffix=".txt", prefix="qwen_", text=True)
with os.fdopen(fd, "w", encoding="utf-8") as f:
    f.write("<|im_start|>system\n你是廖建军<|im_end|>\n<|im_start|>user\n你是谁？<|im_end|>\n<|im_start|>assistant\n")

batch = r"D:\files\qwen-chat\scripts\run_llama.bat"
print(f"Running: {batch} {path}")
sys.stdout.flush()

# KEY: redirect stderr to stdout to avoid pipe deadlock
proc = subprocess.Popen(
    [batch, path],
    stdout=subprocess.PIPE,
    stderr=subprocess.STDOUT,
    shell=False
)
print(f"PID: {proc.pid}")
sys.stdout.flush()

try:
    out, _ = proc.communicate(timeout=90)
    text = out.decode("utf-8", errors="replace")
    print(f"Exit code: {proc.returncode}")
    print(f"Output ({len(text)} chars):")
    print(text[:3000])
except subprocess.TimeoutExpired:
    print("TIMEOUT - killing")
    proc.kill()
    out, _ = proc.communicate()
    print(f"after kill: {out.decode('utf-8', errors='replace')[:500]}")
except Exception as e:
    print(f"Error: {e}")
finally:
    os.unlink(path)