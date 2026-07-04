"""
Extract ALL QQ messages from decrypted Msg3.0.db.
Text messages: parse protobuf double-TLV to get text.
Non-text messages: tag as [image], [voice], [emoji] etc.
"""
import sqlite3
import json
import struct
from datetime import datetime

DB_PATH = r"C:\Users\a1\Msg3.0.db_0_1783155434.db"
MY_UIN = os.environ.get("MY_QQ", "<your_qq>")
FRIEND_UIN = 1026044893
OUTPUT_FILE = r"D:\files\qwen-chat\chat_records\qq_1026044893_final.jsonl"

MsgText = 1
MsgFace = 2
MsgGroupImage = 3
MsgPrivateImage = 6
MsgVoice = 7
MsgNickName = 18
MsgVideo = 26
MsgPrivateFile = 45

TYPE_NAMES = {
    MsgText: "text",
    MsgFace: "emoji",
    MsgGroupImage: "image",
    MsgPrivateImage: "image",
    MsgVoice: "voice",
    MsgNickName: "nickname",
    MsgVideo: "video",
    MsgPrivateFile: "file",
}


def parse_msg_content(buf):
    """Parse QQ protobuf MsgContent. Returns (text, msg_type)."""
    if not buf or len(buf) < 30:
        return "", "unknown"
    
    off = 8  # skip header
    try:
        off += 12  # time + rand + color
        off += 4   # font metadata
        fn_len = struct.unpack_from('<H', buf, off)[0]; off += 2
        if fn_len > 100 or fn_len % 2 != 0:
            return "", "unknown"
        off += fn_len + 2
    except:
        return "", "unknown"
    
    # Parse outer TLV
    texts = []
    msg_type = "unknown"
    while off + 3 <= len(buf):
        try:
            t = buf[off]; off += 1
            l = struct.unpack_from('<H', buf, off)[0]; off += 2
            if l > len(buf) - off or l > 2000:
                break
            v = buf[off:off+l]
            off += l
            
            if t == MsgText:
                msg_type = "text"
                # Parse inner TLV
                inner_off = 0
                while inner_off + 3 <= len(v):
                    it = v[inner_off]; inner_off += 1
                    il = struct.unpack_from('<H', v, inner_off)[0]; inner_off += 2
                    if il > len(v) - inner_off or il > 500:
                        break
                    iv = v[inner_off:inner_off+il]
                    inner_off += il
                    if it == MsgText:
                        try:
                            text = iv.decode('utf-16')
                            if text.strip():
                                texts.append(text)
                        except:
                            pass
            elif t == MsgFace:
                msg_type = "emoji"
            elif t in (MsgGroupImage, MsgPrivateImage):
                msg_type = "image"
            elif t == MsgVoice:
                msg_type = "voice"
            elif t == MsgVideo:
                msg_type = "video"
            elif t == MsgPrivateFile:
                msg_type = "file"
            elif t == 13:
                msg_type = "emoji"
                # Try decode inner
                inner_off = 0
                while inner_off + 3 <= len(v):
                    it = v[inner_off]; inner_off += 1
                    il = struct.unpack_from('<H', v, inner_off)[0]; inner_off += 2
                    if il > len(v) - inner_off or il > 500:
                        break
                    iv = v[inner_off:inner_off+il]
                    inner_off += il
                    if it == MsgText:
                        try:
                            text = iv.decode('utf-16')
                            if text.strip():
                                texts.append(text)
                        except:
                            pass
        except:
            break
    
    return " ".join(texts), msg_type


def main():
    print(f"Connecting to {DB_PATH}...")
    conn = sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True)
    cur = conn.cursor()
    
    table = "buddy_1026044893"
    print(f"Processing {table}...")
    
    cur.execute(f"SELECT Time, SenderUin, MsgContent FROM {table}")
    
    count = 0
    friend_count = 0
    type_stats = {}
    
    with open(OUTPUT_FILE, 'w', encoding='utf-8') as fout:
        for ts, sender, content in cur.fetchall():
            if not content:
                continue
            
            buf = bytes(content) if isinstance(content, (bytes, memoryview)) else None
            
            if buf:
                text, msg_type = parse_msg_content(buf)
            else:
                text = content if isinstance(content, str) else ""
                msg_type = "text" if text else "unknown"
            
            count += 1
            type_stats[msg_type] = type_stats.get(msg_type, 0) + 1
            
            # Format time
            try:
                time_str = datetime.fromtimestamp(ts).strftime('%Y-%m-%d %H:%M:%S')
            except:
                time_str = str(ts)
            
            # For non-text, add type tag to text
            if msg_type != "text" and not text:
                text = f"[{msg_type}]"
            elif msg_type == "emoji" and text:
                text = text  # Keep emoji text like 👴
            
            record = {
                'time': time_str,
                'timestamp': ts,
                'sender': sender,
                'type': msg_type,
                'text': text
            }
            fout.write(json.dumps(record, ensure_ascii=False) + '\n')
            
            if sender == FRIEND_UIN:
                friend_count += 1
    
    conn.close()
    
    print(f"\n=== DONE ===")
    print(f"Total: {count}")
    print(f"Friend (1026044893): {friend_count}")
    print(f"Type breakdown:")
    for t, c in sorted(type_stats.items(), key=lambda x: -x[1]):
        print(f"  {t}: {c}")
    print(f"Output: {OUTPUT_FILE}")


if __name__ == '__main__':
    main()
