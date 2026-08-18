# model/

模型文件存放目录。**本项目不塞大文件**，模型文件不入库，用脚本拉取/提示放置。

## 应放内容

| 文件 | 用途 | 大小 |
|------|------|------|
| `qwen3-embedding-0.6b-q8_0.gguf` | RAG embedding 模型（127.0.0.1:8081 服务） | ~0.6B Q8 |
| `deepseek-v4-flash.gguf`（如有） | LLM 主模型（127.0.0.1:8317 服务） | 见下 |

## LoRA 适配器

LoRA adapter 在 `adapters/`（本项目已入库的小文件）：

- `adapter.gguf`（~32MB）
- `style_weighted_mix_zh_3k_r4.gguf`（~8MB）

## 注意

- 大模型文件（GB 级）一律**不要 commit 进 git**，放本目录并确保被 `.gitignore` 忽略
- embedding 服务 8081 与 LLM 服务 8317 的启动方式见 `docs/` 相关文档
