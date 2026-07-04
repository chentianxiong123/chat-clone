import json

f = 'D:/files/qwen-chat/chat_records/wechat_wxid_example_raw.jsonl'
with open(f, 'r', encoding='utf-8') as fp:
    lines = fp.readlines()

# Check emoji raw content
print("Raw emoji samples:")
count = 0
for line in lines:
    msg = json.loads(line.strip())
    if msg.get('type') == 47:
        content = msg.get('content', '')
        print(f"  content={repr(content[:150])}")
        count += 1
        if count >= 10:
            break
