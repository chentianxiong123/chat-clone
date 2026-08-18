# 并发嵌入快速建库指南

本文档描述如何使用多个 worker 并发填充 SQLite-vec 嵌入数据库，实现快速向量库构建。

---

## 架构概览

```text
embed_worker_sqlite_vec.py (唯一脚本)
      |
      +-- provider=local     --> llama-server (RX590 独显, batch=32)
      +-- provider=cloudflare --> Cloudflare Workers AI (batch=1)
      +-- provider=pie-xian  --> Pie-Xian API (batch=1)
      +-- provider=futureppo --> FuturePPO API (batch=1)
      |
      v
  SQLite-vec 数据库 (WAL模式, 并发安全)
```

**核心设计**: 所有 worker 共用同一个脚本和数据库，通过 `--provider` 参数区分来源，SQLite WAL 模式保证并发写入安全。Worker 通过 `claim` 机制互相抢任务，不会重复处理。

---

## 前置条件

### 1. 环境准备

```bash
cd <project_root>
.venv\Scripts\pip install openai sqlite-vec
```

### 2. 初始化数据库

```bash
.venv\Scripts\python.exe scripts/init_rag_sqlite_vec.py
```

### 3. 启动本地 llama-server（可选）

如果要用本地 GPU 嵌入，需要先启动 llama-server：

```bash
<llama_build>\llama-server.exe ^
  --model <model_dir>\qwen3-embedding-0.6b-q8_0.gguf ^
  --host 127.0.0.1 --port 8081 ^
  --embedding --pooling last --embd-normalize 2 ^
  --main-gpu 0 --n-gpu-layers 9999 ^
  --batch-size 512 --ctx-size 8192
```

等待 `Health: ok` 后再启动 worker。

---

## 环境变量配置

所有远程 API 密钥通过环境变量传递，**不硬编码在文档或脚本中**：

```bash
set CLOUDFLARE_WORKERS_URL=https://<your-worker>.workers.dev/v1/embeddings
set PIEXIAN_ENDPOINT=https://api.pie-xian.com/v1/embeddings
set PIEXIAN_API_KEY=<your_pie_xian_key>
set FUTUREPPO_ENDPOINT=https://api.futureppo.top/v1/embeddings
set FUTUREPPO_API_KEY=<your_futureppo_key>
```

---

## 启动命令

### 本地 GPU（RX590, batch=32, 最快）

```bash
<venv_python> scripts/embed_worker_sqlite_vec.py ^
  --provider local --model qwen3-embedding-0.6b ^
  --endpoint http://127.0.0.1:8081/v1/embeddings ^
  --batch-size 32 --limit 5000 ^
  --claim-any-provider --claim-any-model
```

### Cloudflare Workers AI（免费额度, batch=1）

```bash
<venv_python> scripts/embed_worker_sqlite_vec.py ^
  --provider cloudflare --model qwen3-embedding-0.6b ^
  --endpoint %CLOUDFLARE_WORKERS_URL% ^
  --batch-size 1 --limit 500 ^
  --claim-any-provider --claim-any-model
```

### Pie-Xian API（batch=1）

```bash
<venv_python> scripts/embed_worker_sqlite_vec.py ^
  --provider pie-xian --model qwen3-embedding-0.6b ^
  --endpoint %PIEXIAN_ENDPOINT% ^
  --api-key %PIEXIAN_API_KEY% ^
  --batch-size 1 --limit 200 ^
  --claim-any-provider --claim-any-model
```

### FuturePPO API（batch=1）

```bash
<venv_python> scripts/embed_worker_sqlite_vec.py ^
  --provider futureppo --model qwen3-embedding-0.6b ^
  --endpoint %FUTUREPPO_ENDPOINT% ^
  --api-key %FUTUREPPO_API_KEY% ^
  --batch-size 1 --limit 200 ^
  --claim-any-provider --claim-any-model
```

---

## 关键参数说明

| 参数 | 说明 | 建议值 |
|------|------|--------|
| `--provider` | 标识来源，写入 embedding_jobs 表 | 任意标识符 |
| `--model` | 嵌入模型名 | `qwen3-embedding-0.6b` |
| `--endpoint` | OpenAI 兼容的嵌入 API 端点 | 见上方各平台 |
| `--api-key` | API 密钥（本地不需要，远程从环境变量读取） | 见上方各平台 |
| `--batch-size` | 每次请求的文本数 | 本地 32, 远程 1 |
| `--limit` | 处理多少条后退出（0=无限） | 200-5000 |
| `--claim-any-provider` | 允许抢任何 provider 的 pending 任务 | 必须加 |
| `--claim-any-model` | 允许抢任何 model 的 pending 任务 | 必须加 |

---

## 并发策略

### 启动顺序

1. 先启动 llama-server（如果用本地 GPU）
2. 等 Health check 通过
3. 启动所有 worker（可以同时启动，互不影响）

### 内存管理

- **llama-server**: 长时间运行会内存泄漏（可能吃满 9GB+），建议跑完后手动 kill
- **Python worker**: 每个约 30-40MB 内存，可以安全跑多个
- **建议**: 每跑 200-500 条重启一次 worker，避免内存堆积导致 SSD 磨损

### 嵌入参数统一

所有平台必须保持一致的嵌入参数：

- **Pooling**: last
- **Normalize**: 2 (L2)
- **输入格式**: 纯文本（无系统提示词、无 instruction）
- **文本格式**: `用户: <文本>` / `助手: <文本>`

---

## 监控进度

### 查看嵌入状态

```python
import sqlite3
db = r'<project_root>\workspace\07_rag_embedding\stores\qwen_persona_rag.sqlite'
conn = sqlite3.connect(db)
c = conn.cursor()
c.execute("SELECT status, COUNT(*) FROM embedding_jobs GROUP BY status")
for s, cnt in c.fetchall():
    print(f"{s}: {cnt}")
conn.close()
```

### 状态含义

- **pending**: 等待处理
- **claimed**: worker 正在处理中
- **done**: 已完成嵌入
- **failed**: 失败（可重置为 pending 重试）

### 重试失败任务

```python
import sqlite3
db = r'<project_root>\workspace\07_rag_embedding\stores\qwen_persona_rag.sqlite'
conn = sqlite3.connect(db, timeout=10)
c = conn.cursor()
c.execute("""UPDATE embedding_jobs
    SET status = 'pending', attempts = 0,
        claimed_by = NULL, claimed_at = NULL, last_error = NULL,
        updated_at = datetime('now')
    WHERE status = 'failed'""")
print(f"重置 {c.rowcount} 条 failed 为 pending")
conn.commit()
conn.close()
```

---

## 实际性能参考

以 17,846 条数据为例（2026-07-10 实测）：

| 方式 | 单条耗时 | 总耗时 | 贡献量 |
|------|----------|--------|--------|
| 本地 RX590 (batch=32) | ~0.7s/条 | ~20min | 12,086 (68%) |
| Cloudflare (batch=1) | ~2s/条 | ~60min | 1,035 (6%) |
| Pie-Xian (batch=1) | ~2s/条 | ~60min | 1,804 (10%) |
| FuturePPO (batch=1) | ~2s/条 | ~60min | 2,187 (12%) |

**4 个 worker 并发跑完 ~18,000 条，总耗时约 30-40 分钟。**

---

## 一键启动脚本（PowerShell）

```powershell
# start_all_workers.ps1
$venv  = "<project_root>\.venv\Scripts\python.exe"
$script = "<project_root>\scripts\embed_worker_sqlite_vec.py"
$db     = "<project_root>\workspace\07_rag_embedding\stores\qwen_persona_rag.sqlite"
$common = @("--db", $db, "--model", "qwen3-embedding-0.6b", "--claim-any-provider", "--claim-any-model")

# 本地 GPU
Start-Process $venv -ArgumentList @($script) + $common + @(
    "--provider", "local",
    "--endpoint", "http://127.0.0.1:8081/v1/embeddings",
    "--batch-size", "32", "--limit", "5000")

# Cloudflare
Start-Process $venv -ArgumentList @($script) + $common + @(
    "--provider", "cloudflare",
    "--endpoint", $env:CLOUDFLARE_WORKERS_URL,
    "--batch-size", "1", "--limit", "500")

# Pie-Xian
Start-Process $venv -ArgumentList @($script) + $common + @(
    "--provider", "pie-xian",
    "--endpoint", $env:PIEXIAN_ENDPOINT,
    "--api-key", $env:PIEXIAN_API_KEY,
    "--batch-size", "1", "--limit", "200")

# FuturePPO
Start-Process $venv -ArgumentList @($script) + $common + @(
    "--provider", "futureppo",
    "--endpoint", $env:FUTUREPPO_ENDPOINT,
    "--api-key", $env:FUTUREPPO_API_KEY,
    "--batch-size", "1", "--limit", "200")

Write-Host "4 workers launched"
```

---

## 注意事项

1. **必须用 venv**: 系统 python 没有 sqlite_vec 模块，直接运行会报 `ModuleNotFoundError: No module named 'sqlite_vec'`
2. **SQLite WAL 模式**: 多个 worker 可以同时写入，但高并发时偶尔会有 database locked 错误，worker 会自动重试
3. **RX590 GME**: 驱动报告显存 4GB，Q8_0 模型 610MB，但 llama-server 实际内存占用可能达到 9GB+，这是已知的内存泄漏问题
4. **云端 API 限速**: 每个免费 API 每天约 100 次调用额度，跑完需要第二天续额
5. **数据安全**: 嵌入完成后建议备份 sqlite 文件
6. **claimed 卡住**: 如果 worker 被强杀，部分任务会卡在 claimed 状态，需要手动重置为 pending
