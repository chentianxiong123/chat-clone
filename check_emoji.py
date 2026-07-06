import json
import argparse

parser = argparse.ArgumentParser(description="Print raw emoji samples from a chat JSONL file.")
parser.add_argument("--input", required=True)
parser.add_argument("--limit", type=int, default=10)
args = parser.parse_args()

with open(args.input, 'r', encoding='utf-8') as fp:
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
        if count >= args.limit:
            break
