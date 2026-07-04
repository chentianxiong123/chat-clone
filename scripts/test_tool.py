import subprocess, sys, os, json, time, urllib.request

proc = subprocess.Popen(
    [sys.executable, os.path.join(os.path.dirname(__file__), "api_server.py")],
    stdout=subprocess.PIPE, stderr=subprocess.PIPE
)
time.sleep(2)

try:
    data = json.dumps({
        "messages": [
            {"role": "system", "content": """你是一个智能助手，可以使用工具。
可用工具：
- get_weather: 获取天气, arguments: {"city": "城市名"}
- search_web: 搜索网络, arguments: {"query": "关键词"}
当你需要使用工具时，输出工具名和参数。"""},
            {"role": "user", "content": "帮我查一下广州的天气"}
        ],
        "max_tokens": 150,
        "temperature": 0.7
    }).encode()

    req = urllib.request.Request("http://localhost:8080", data=data,
                                 headers={"Content-Type": "application/json"})
    resp = urllib.request.urlopen(req, timeout=180)
    result = json.loads(resp.read())
    print(json.dumps(result, ensure_ascii=False, indent=2))
except Exception as e:
    print(f"Error: {e}")
finally:
    proc.terminate()
    proc.wait()