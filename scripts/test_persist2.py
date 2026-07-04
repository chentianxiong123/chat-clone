import subprocess, sys, json, time, threading, os, re

LLAMA = r"D:\files\qwen-chat\bin\llama-cli.exe"
MODEL = r"D:\files\qwen-chat\models\qwen2.5-0.5b-instruct-q4_k_m.gguf"
# Use cmd /c to properly handle console I/O
CMD = f'cmd /c ""{LLAMA}" -m "{MODEL}" -ngl 99 -mg 1 --interactive --interactive-first --no-display-prompt --temp 0.7 -c 2048"'

print("Starting persistent llama-cli in interactive mode...")
proc = subprocess.Popen(
    CMD,
    stdin=subprocess.PIPE,
    stdout=subprocess.PIPE,
    stderr=subprocess.STDOUT,
    shell=True,
    # No creationflags - let it inherit our console
)

# Read until first prompt
time.sleep(5)
buf = b""
while True:
    ch = proc.stdout.read(1)
    if not ch: break
    buf += ch
    if b"> " in buf:
        break

print("Model ready! Prompt seen in output.")
print(f"Banner size: {len(buf)} bytes")

# Now send a prompt
prompt = "<|im_start|>user\n你好<|im_end|>\n<|im_start|>assistant\n"
proc.stdin.write(prompt.encode("utf-8"))
proc.stdin.flush()

# Read response
time.sleep(3)
out = b""
t0 = time.time()
while time.time() - t0 < 30:
    ch = proc.stdout.read(1)
    if not ch: break
    out += ch
    text = out.decode("utf-8", errors="replace")
    if "> " in text[-4:]:
        print("Got prompt marker, response complete")
        break

# Clean output
ansi = re.compile(r'\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])')
clean = ansi.sub('', out.decode("utf-8", errors="replace"))
print("=== RESPONSE ===")
# Extract text between <|im_start|>assistant and next >
lines = clean.split("\n")
collecting = False
for l in lines:
    s = l.strip()
    if "<|im_start|>assistant" in s:
        collecting = True
        continue
    if collecting and s == ">" or s.startswith("> "):
        break
    if collecting and s and not s.startswith("[") and "t/s" not in s:
        print(s)

proc.terminate()
proc.wait()
print("\nDone")