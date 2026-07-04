cd D:\files\qwen-chat\llama
.\llama-cli.exe -m ..\qwen2.5-0.5b-instruct-q4_k_m.gguf --lora ..\adapter.gguf -ngl 99 -mg 1 --temp 0 -p "你叫什么名字" -n 20 --no-display-prompt 2>$null
echo ---
.\llama-cli.exe -m ..\qwen2.5-0.5b-instruct-q4_k_m.gguf --lora ..\adapter.gguf -ngl 99 -mg 1 --temp 0 -p "你是谁" -n 20 --no-display-prompt 2>$null
echo ---
.\llama-cli.exe -m ..\qwen2.5-0.5b-instruct-q4_k_m.gguf -ngl 99 -mg 1 --temp 0 -p "你叫什么名字" -n 20 --no-display-prompt 2>$null