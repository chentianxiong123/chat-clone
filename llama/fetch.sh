#!/usr/bin/env bash
# 拉取 llama.cpp-lora-embed（qlora 分支）源码
# 用途：本地跑 RAG embedding + LoRA 推理（RX580/RX590）
# 仓库：https://github.com/chentianxiong123/llama.cpp-lora-embed
set -euo pipefail

REPO_URL="https://github.com/chentianxiong123/llama.cpp-lora-embed.git"
BRANCH="qlora"
DEST="$(cd "$(dirname "$0")" && pwd)/llama.cpp-lora-embed"

if [ -d "$DEST/.git" ]; then
  echo "已存在 $DEST，执行 git pull 更新…"
  git -C "$DEST" checkout "$BRANCH"
  git -C "$DEST" pull --ff-only
else
  echo "克隆 $BRANCH 分支到 $DEST …"
  git clone --branch "$BRANCH" --depth 1 "$REPO_URL" "$DEST"
fi

echo
echo "完成。源码在: $DEST"
echo "Linux 编译提示:"
echo "  cd $DEST && mkdir -p build && cd build"
echo "  cmake .. -DGGML_VULKAN=ON   # RX580/RX590 需要 Vulkan 后端"
echo "  cmake --build . -j$(nproc)"
