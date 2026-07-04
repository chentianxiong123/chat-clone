# Qwen-Chat RX580 项目文档

这是一个围绕 AMD RX580 / RX 590 GME 8GB 显卡、Vulkan 后端和 llama.cpp QLoRA 训练链路搭建的本地聊天 agent 实验项目。项目重点是验证 RX580 级别显卡上运行 Qwen/Qwen2.5 小模型、LoRA/QLoRA 微调、私聊语料清洗、60m 大段切分、agent 并发细分和后续拟人化聊天 agent 数据构造流程。

## 项目结构

```
D:\files\qwen-chat\
├── bin/                                ← 编译好的 QLoRA 工具
│   ├── llama-finetune-qlora.exe        ←  QLoRA 训练 (52MB)
│   ├── llama-cli.exe                   ←  推理/对话 (53MB)
│   ├── libssl-3-x64.dll                ←  OpenSSL 运行库
│   └── libcrypto-3-x64.dll             ←  OpenSSL 运行库
│
├── models/                             ← HuggingFace/ModelScope 模型缓存
│
├── qwen2.5-0.5b-instruct-q4_k_m.gguf   ← 基础模型 (480MB, 630M params)
├── adapter.gguf                        ← 当前 LoRA 适配器 (31MB)
│
├── train_data.jsonl                    ← 训练数据模板 (10条)
├── train_exp.jsonl                     ← 实验数据 (8条)
├── test_compare.py                     ← 对比测试脚本
├── test_lora.bat                       ← 命令行测试脚本
└── README.md                           ← 项目文档
```

---

## 技术路线探索

### 路线一：PyTorch + DirectML + PEFT (试错 → 废弃)

**出发点：** 想在 RX 590 上直接用 Python 生态做 LoRA 训练。先装 PyTorch，发现不支持 AMD；
改装 torch-directml。

**第一个坑：无法连接 HuggingFace**
```
pip install 报错，huggingface.co 被墙
```
→ 改用 ModelScope（阿里镜像），下载 Qwen2.5-0.5B-Instruct 成功

**第二个坑：Trainer 不认识 DirectML 设备**
```python
trainer = Trainer(model=model, ...)
# TypeError: got an unexpected keyword argument 'tokenizer'
# Transformers 5.x API 改了，tokenizer → processing_class
```
修完 API 后又发现：
```
RuntimeError: CUDA error — Trainer 不认识 DML 的 privateuseone 设备
```
→ 放弃 Trainer，改用手动训练循环

**第三个坑：AdamW 的 lerp 回退 CPU**
```
UserWarning: 'aten::lerp.Scalar_out' is not supported on DML, falling back to CPU
```
每一步优化都得 GPU → CPU → GPU 来回拷。效率极低。

**第四个坑：微软已放弃维护**
查 GitHub Issues 确认 torch-directml 最后更新 2024.9，大量 Issues 标记 "Not planned"。
所有缺失算子（lerp, dropout, group_norm_backward）都不会补了。

**结论：❌ 废弃**
可用 SGD 替代 AdamW 缓解 CPU 回退，但项目已死，没有未来。

---

### 路线二：llama.cpp finetune (全参数微调) (试错 → 废弃)

**出发点：** 既然 DML 不行，试试原生 C++ 的 llama.cpp finetune。
编译工具（MSVC + CMake）已确认可用。

**编译成功，但发现三个致命问题：**

1. **预编译包不包含 finetune**
   - b9867 和 b9870 的 Vulkan 包里都没有 `llama-finetune.exe`
   - 必须从源码编译。而从源码编译需要 Vulkan SDK 头文件
   - 下载 Vulkan SDK 1.4.350.0（~500MB，通过 winget 安装）

2. **全参数训练，不是 LoRA**
   ```
   examples/training/finetune.cpp 做的是完整参数微调
   会修改模型所有 630M 权重，不是 LoRA
   需要 F32 模型（Q4 要转），内存 ~12-15GB
   ```

3. **训练只支持 CPU**
   ```
   官方 README 明确写 "For CPU training, compile without CUDA"
   finetune 的反向传播不走 GPU，只走 CPU
   GPU 仅用于前向推理 — 浪费 RX 590
   ```

**进一步搜索：有没有 llama.cpp 的分支做了 LoRA 训练？**

搜遍 GitHub forks 和 PRs：
- ggerganov/llama.cpp 的全部 20,000+ forks 挨个看
- 关键词：lora, qlora, finetune, training, 微调
- 只有一份相关代码：PR #22705 "Feat/qlora training"
- 156 个 commit，Draft 状态，未合并

**结论：❌ 废弃（全参数不满足需求，必须 LoRA）**

---

### 路线三：PR #22705 QLoRA + Vulkan (当前采用 ✅)

**方案：** 编译 srossitto79/llama.cpp 的 `feat/qlora-training-v2` 分支，带 Vulkan 后端

**拉分支时遇到的坑：** 156 个 commit 直接 `git fetch` 超时
→ 改用 `git fetch --depth=1` 只拉最新代码

**编译成功**（MSVC 19.44 + Vulkan SDK 1.4.350.0 + CMake）

**验证训练：**
```
llama-finetune-qlora.exe \
  --model qwen2.5-0.5b-instruct-q4_k_m.gguf \
  --train-file train_exp.jsonl \
  --lora-rank 16 --lora-alpha 16 \
  -c 512 -b 512 -ub 512 \
  --epochs 30 -lr 5e-4 \
  --lora-out adapter.gguf \
  -ngl 99 -mg 1
```
全程在 RX 590 上跑通。

**训练中的观察：**
- loss 先降后升（5 条数据太少，过拟合起点极低）
- 30 epoch 跑完约 3 分钟
- LoRA 参数变化：b_L2 从 0 → 6.2（权重明显改变）

**验证推理：**
```
# 无 LoRA
> 你叫什么名字
我是来自阿里云的超大规模语言模型，我叫通义千问。

# 有 LoRA（旧版 b9867 推理）
> 你叫什么名字
廖建军章   ← 学对了但多个"章"字

# 有 LoRA（新版 PR 推理）
> 你叫什么名字
廖建军章   ← 结果一致
```

**"章"字的原因分析：**
1. 训练数据只有 8 条，LoRA 没学到"在哪停止"
2. 训练数据经过 chat template 展开后有 `<|im_end|>` 标记
3. 但推理时直接用 `-p` 传裸文本，模型不知道结束时应该输出 EOS
4. 旧版 b9867 对新版 LoRA 格式解析不完全

**实验结论：**
- ✅ 管道全部打通：编译 → 训练 → 推理
- ✅ RX 590 原生支持 QLoRA 训练
- ⚠️ 效果依赖数据量，8 条太少
- ⚠️ 新版 PR 的 llama-cli 输出日志有 bug（stdout/stderr 混排）

**下一步计划：**
- 用 system prompt 定义角色身份
- 准备 50-200 条真实风格对话
- 调优学习率和 epoch 数量

---

## 硬件配置

| 组件 | 型号 |
|---|---|
| GPU | AMD Radeon RX 590 GME (OCuLink 外接) |
| VRAM | 8GB（Vulkan 确认） |
| 系统内存 | 16GB |
| 系统 | Windows |
| 编译器 | MSVC 19.44 (VS BuildTools) |
| Vulkan SDK | 1.4.350.0 |

---

## 训练配置 (当前)

```
--model        qwen2.5-0.5b-instruct-q4_k_m.gguf
--lora-rank    16
--lora-alpha   16
--ctx-size     512
--batch-size   512
--ubatch-size  512
--lr           2e-4
--epochs       10
--optimizer    AdamW (Vulkan 原生实现)
--ngl          99
--mg           1 (Vulkan1 = RX 590)
```

---

## 待解决问题

### 1. 数据格式 (已确定)
- 用 `system` prompt 定义角色身份（名字、性格、背景）
- `user/assistant` 保持标准格式（Qwen 原生支持）
- 不改代码，角色名放 system prompt 里

### 2. 训练数据量
- 当前测试：8-10 条 → 效果粗糙，有过拟合
- 目标：50-200 条高质量对话对
- 来源：7 年聊天记录，滑动窗口提取

### 3. 数据处理
- 数据清洗（去重、去广告、脱敏）
- 滑动窗口切段（size=8, step=2）
- 时间断档 >30分钟 切分
- 用大模型（GLM-4-Flash / DeepSeek）筛选高价值窗口

### 4. 长期规划
- 当前：LoRA 注入身份 + 风格
- 中期：RAG（FAISS + bge-small-zh）做知识库
- 远期：状态机 + 逻辑层
