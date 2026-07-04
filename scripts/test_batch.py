import subprocess, sys, os, json, tempfile, time

fd, path = tempfile.mkstemp(suffix=".txt", prefix="qwen_", text=True)
with os.fdopen(fd, "w", encoding="utf-8") as f:
    f.write("<|im_start|>system\n你是廖建军<|im_end|>\n<|im_start|>user\n你是谁？<|im_end|>\n<|im_start|>assistant\n")

# Use batch file
batch = r"D:\files\qwen-chat\scripts\run_llama.bat"
print(f"Running: {batch} {path}")
sys.stdout.flush()

proc = subprocess.Popen(
    [batch, path],
    stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    shell=False
)
print(f"PID: {proc.pid}")
sys.stdout.flush()

try:
    out, err = proc.communicate(timeout=90)
    print(f"Exit code: {proc.returncode}")
    print(f"stdout ({len(out)} bytes):")
    print(out.decode("utf-8", errors="replace")[:500])
    print(f"stderr ({len(err)} bytes):")
    print(err.decode("utf-8", errors="replace")[:2000])
except subprocess.TimeoutExpired:
    print("TIMEOUT - killing")
    proc.kill()
    out, err = proc.communicate()
    print(f"stdout after kill: {out.decode('utf-8', errors='replace')[:200]}")
    print(f"stderr after kill: {err.decode('utf-8', errors='replace')[:500]}")
except Exception as e:
    print(f"Error: {e}")
finally:
    os.unlink(path)