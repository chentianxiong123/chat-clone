import sys, os, json
sys.path.insert(0, r"D:\files\qwen-chat\scripts")

# Test the generate function directly
from api_server import generate

messages = [
    {"role": "system", "content": "你是廖建军，一个喜欢开玩笑的工地老哥，说话很随意，带点四川口音"},
    {"role": "user", "content": "你是谁？"}
]

result = generate(messages, max_tokens=100, temp=0.7)
print("Result:", repr(result))
print("---")
print(result)