# llama/

本项目不塞二进制，本目录只提供**拉取/构建脚本与资料**。

## 用途

本地跑 RAG embedding + LoRA 推理（RX580/RX590 低成本 GPU 方案）所用的
llama.cpp 家族引擎源码。

## 仓库

| 项 | 值 |
|----|----|
| 仓库 | `chentianxiong123/llama.cpp-lora-embed`（私有） |
| 分支 | `qlora` |
| 拉取脚本 | `./fetch.sh` |

## 使用方法

```bash
./fetch.sh            # 克隆/更新源码到 ./llama.cpp-lora-embed
```

## 编译提示（Linux + RX580/RX590）

```bash
cd llama.cpp-lora-embed
mkdir -p build && cd build
cmake .. -DGGML_VULKAN=ON     # RX580/RX590 需要 Vulkan 后端
cmake --build . -j$(nproc)
```

## 相关仓库

- `stable-diffusion.cpp-flux2-klein-rx580` — FLUX2 Klein RX580/RX590 CLI fork（图像生成，独立于此）

## 历史

- 本目录前身是 `bin/`，存放 Windows 版 llama.cpp 二进制（Windows 开发时产物）。
  清单存档见 [BINARIES.md](./BINARIES.md)，二进制已删除。
