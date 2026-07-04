import subprocess, os

llama = r"D:\files\qwen-chat\llama\llama-cli.exe"
model = r"D:\files\qwen-chat\qwen2.5-0.5b-instruct-q4_k_m.gguf"
lora = r"D:\files\qwen-chat\adapter.gguf"

questions = ["你叫什么名字", "你是谁", "你的名字"]

print("=== 有 LoRA ===")
for q in questions:
    r = subprocess.run([llama, "-m", model, "--lora", lora, "-ngl", "99", "-mg", "1", "--temp", "0", "-p", q, "-n", "20", "--no-display-prompt"],
        capture_output=True, text=True, cwd=r"D:\files\qwen-chat\llama")
    out = r.stdout.split(">")[-1].strip() if ">" in r.stdout else r.stdout.strip()
    print(f"Q: {q}")
    print(f"A: {out}")
    print()

print("=== 无 LoRA（基线）===")
for q in questions:
    r = subprocess.run([llama, "-m", model, "-ngl", "99", "-mg", "1", "--temp", "0", "-p", q, "-n", "20", "--no-display-prompt"],
        capture_output=True, text=True, cwd=r"D:\files\qwen-chat\llama")
    out = r.stdout.split(">")[-1].strip() if ">" in r.stdout else r.stdout.strip()
    print(f"Q: {q}")
    print(f"A: {out}")
    print()