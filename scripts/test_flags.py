import subprocess, sys, os, json, tempfile, time

fd, path = tempfile.mkstemp(suffix=".txt", prefix="qwen_", text=True)
with os.fdopen(fd, "w", encoding="utf-8") as f:
    f.write("<|im_start|>system\n你是一个AI助手<|im_end|>\n<|im_start|>user\n你好<|im_end|>\n<|im_start|>assistant\n")

args = [
    r"D:\files\qwen-chat\bin\llama-cli.exe",
    "-m", r"D:\files\qwen-chat\models\qwen2.5-0.5b-instruct-q4_k_m.gguf",
    "-ngl", "99", "-mg", "1",
    "--temp", "0.7", "-n", "100",
    "--no-display-prompt", "-f", path
]

for flag, name in [(0x00000008, "DETACHED_PROCESS"), (0x00000010, "CREATE_NEW_CONSOLE"), (0x08000000, "CREATE_NO_WINDOW")]:
    proc = subprocess.Popen(
        args, stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        creationflags=flag
    )
    try:
        out, _ = proc.communicate(timeout=45)
        text = out.decode("utf-8", errors="replace")
        # Check if generation happened
        if "<|im_start|>assistant" in text:
            after = text.split("<|im_start|>assistant")[-1]
            # Check if there's actual content (not just empty/progress/error)
            lines = [l.strip() for l in after.split("\n") if l.strip()]
            non_banner = [l for l in lines if not l.startswith("[") and "t/s" not in l and not l.startswith(">") and not l.startswith("Exiting")]
            if non_banner:
                print(f"{name}: OK - generated: {non_banner[0][:60]}")
            else:
                print(f"{name}: No generation (banner only)")
        else:
            print(f"{name}: No response marker found")
    except subprocess.TimeoutExpired:
        proc.kill()
        print(f"{name}: TIMEOUT (45s)")
    except Exception as e:
        print(f"{name}: Error: {e}")

os.unlink(path)