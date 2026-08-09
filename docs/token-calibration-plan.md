# Token Calibration — 让 pending 计算对齐 provider 真实 token

> 分支：`feat/token-calibration`（worktree: `/Users/yintianan/GitHub/billion-context-pi-wt2`）
> 状态：**研究阶段（draft）** — 方案讨论中，尚未实现
> 实测环境：**DeepSeek V4-Flash**（1M 窗口）。其 tokenizer 中英文密度差异大
> （官方：1 英文字符 ≈ 0.3 token、1 中文字符 ≈ 0.6 token，中文密度为英文 2 倍；
> 实测 1 汉字 ≈ 1.2-1.3 token），chars/4 估算对中文内容严重低估 —— 本方案的
> 校准系数正是为此而设。

## 1. 问题

nudge 触发判断（`decideNudge` 的 `pendingByTier`）依赖可压缩范围的 token 数，
但内核里存在**三处口径分裂**，导致系统判断的"可压缩量"与用户看到的 footer（provider
真实 usage）严重不符：

| 位置 | 算法 | 问题 |
|---|---|---|
| `buildCompressibleRanges` → `estimateMessageTokens`（T1 pending 源头） | `Math.ceil(len/4)` 纯 chars/4 | **中文 1 字符 ≈ 1 token 被算成 0.25**，低估 2-4 倍 |
| `pendingByTier` 的 T2/T3（summary tokens） | 注入的 `countTokens`（CJK-aware ✓） | 与 T1 不一致 |
| `tokenCount`（usage/growth/emergency/footer） | provider 真实 usage（含 system+schema） | 与 pending 完全不同世界 |

**实测现象**（本会话，DeepSeek V4-Flash）：
- ACP 判定：`Nudge: idle — max compressible 40226 < threshold 50000`
- footer 显示：18.1%（provider total ≈ 181K）
- 触发 nudge 时（50K 阈值）：provider total 已达 122K（≈12%）

也就是说：系统认为"才 40K 可压缩，没到 50K"而保持静默，但真实上下文已经 18%、
远超模型甜点区间（Flash ≤128K）。**系统量小了，所以没报警。**

## 1.5 根因（为什么会出现口径分裂）

三条 token 口径在 acp-kernel 里由三个**独立实现**提供，从未被强制统一：

1. **T1 pending 走 `buildCompressibleRanges` → `estimateMessageTokens`（纯 chars/4）**——最简化实现，
   模块级函数，不接收任何注入；
2. **T2/T3 走注入的 `countTokens`（CJK-aware）**——`createCore(ports)` 的 countTokens 注入机制
   （→ ctx.countTokens）早已存在，且 `nudgeNode` 在用；
3. **tokenCount 走 provider 真实 usage**——adapter 层的选择（`src/index.ts:112-114`）。

**关键事实：注入机制早就有了（T2/T3 在用），但 T1 的路径（`buildCompressibleRanges` /
`computeProtectedRefs`）从未接入它，一直用写死的 chars/4。** 这是历史实现未统一的结果，
不是刻意设计——同一个会话里 T1 与 T2/T3 对同一条中文文本会给出不同 token 数。

## 2. 为什么不能直接用 provider 值算 pending

> 【问题由用户提出（2026-08）："为什么不能一开始就从 provider 拿，非要自己算系数？"】

provider 只给**总数**（如"本次请求 181K"），不提供分类：
- 哪些是旧工具输出（可压缩）
- 哪些是最近 5 条消息（保护区）
- 哪些已压缩进块（不计 pending）
- 哪些是 system prompt（永不压缩）

nudge 需要的是**"可压缩子集之和"**，这是分类求和，只有本地知道。
且 provider usage 是**上一轮**的结算值（pi 源码注释："After compaction, the last
assistant usage reflects pre-compaction context size"），压缩后瞬间会失真。
因此：本地估算 + provider 校准系数 = 正确解法。

## 3. 方案：双层校准

### 3.1 第一层（kernel）— `estimateMessageTokens` 改用注入的 countTokens

```js
// 现状（buildCompressibleRanges 内）：
tokens: estimateMessageTokens(msg)          // Math.ceil(len/4)，中文不处理

// 改为：使用注入的 countTokens（默认回落 CJK-aware 的 defaultCountTokens）
tokens: countTokens(msg.text ?? "")
```
- `buildCompressibleRanges` 增加 `countTokens` 参数，`recommendNode` 从 `ctx.countTokens` 传入
- 消除最大的低估源（中文）

### 3.2 第二层（adapter）— 注入"密度校准版" countTokens

新增 `src/density.ts`，维护实时密度系数 `density`：

```
每轮 context 事件：
  Δreal = realUsage.tokens - prevRealUsage.tokens   // provider 真实增量（差值自动消掉 system+schema 固定开销）
  Δest  = estimateTokens(coreMessages) - prevEst     // 估算增量
  if (Δest > 0): instantDensity = Δreal / Δest       // 仅正常增长轮更新
  density = 0.85×density + 0.15×instantDensity       // EMA 平滑
  clamp(density, 0.5, 4)                             // 防单轮异常
```

然后 `createCore({ countTokens: (text) => defaultCountTokens(text) × density })`。

**为什么用相邻差值而非绝对比值**：provider 总量含 ~24K system+schema 固定开销，
直接除会污染系数；相邻两轮差值自动消掉固定开销，得到纯"消息真实 token / 估算 token"密度。
本会话实测密度 ≈ 1.6-1.8（中文为主）。

### 3.3 第三层 — compress 工具返回值与 acp_status 对齐

`compress-tool.ts` 的 `beforeTokens` 与 status breakdown 已用 `defaultCountTokens`
（CJK-aware），统一改走注入的校准 countTokens，让**模型看到的数字、footer、nudge
判断全部同口径**。

## 4. 系数收敛（无预热期）

> 【洞察由用户提出（2026-08）："系数其实在第一轮甚至第二轮对话就能开始算了"】

关键洞察：**系数从第二轮就开始校准，不需要等压缩事件**。

| 轮次 | 锚点 | 系数 |
|---|---|---|
| 第 1 轮 | 无 provider usage（纯估算） | 初始 1 |
| 第 1 轮响应后 | 拿到第一个真实 usage 锚点 | — |
| 第 2 轮起 | Δreal/Δest 可算，每轮喂样本 | 每轮更新，快速收敛 |
| 压缩那一轮 | Δest 为负 | 跳过（唯一例外） |

到真正触发 nudge 时（可压缩积累到阈值，通常几十轮后），系数早已被几十个样本校准稳定。
规则仅一条：`if (Δest > 0) 更新 else 跳过`。

## 5. 边界与风险

1. **压缩瞬间 Δest 为负** → 只在 Δest > 0 时更新，压缩后暂停校准一轮
2. **会话开始无 realUsage** → density 初始 1，第二轮起自然收敛
3. **模型/窗口切换** → `session_start` 重置 density（runtime 已有 `clearNudgeTracking`）
4. **density clamp [0.5, 4]** → 防单轮巨型纯英文输出拉爆系数
5. **T2/T3 不受影响** → summary 本身短，CJK-aware 已足够

## 6. 验证方式

1. 单测：构造中英混合消息，断言 pending = countTokens 口径而非 chars/4
2. 密度模块单测：喂模拟 usage 序列，验证 EMA 收敛 + clamp + 负增量跳过
3. 集成：本会话复现 —— 方案后 `acp_status` 的 max compressible ≈ 64K（≥50K，nudge 触发），
   与 footer 18% 口径自洽

## 7. 预期效果

| 指标 | 现在 | 方案后 |
|---|---|---|
| 可压缩 pending（同内容） | 40.2K（chars/4） | 40.2K × ~1.6 ≈ 64K |
| 50K 阈值触发点（footer 真实值） | ~122K（12%） | ~104K（10%） |
| 触发频率 | 偏晚 | 提前 ~20%，回到 Flash 甜点 |

## 8. 代码事实核实（研究结论，2026-08 已确认）

### 内核侧（node_modules/acp-kernel/dist/index.js）

1. **`estimateMessageTokens`（:805）= `Math.ceil((text?.length ?? 0) / 4)`** 纯 chars/4，3 处调用：
   - :828 `computeProtectedRefs`（保护区 token 累计）
   - :866/:877 `buildCompressibleRanges`（compressible + protected ranges 的 tokens）
2. **`buildCompressibleRanges(messages, state, config, protectedZoneRefs)`（:853）** — 不接收 countTokens，内部写死 estimateMessageTokens
3. **`recommendNode.run`（:1188）** 调用 computeProtectedRefs + buildCompressibleRanges，**均未传 ctx.countTokens**
4. **`decideNudge`（:1495）** 已接收 `countTokens` 参数（由 `nudgeNode.run` :1214-1221 从 `ctx.countTokens` 传入）
5. **`pendingByTier`（:1484）**：T1 pending = `compressible.reduce((s,r) => s + r.tokens, 0)`（chars/4 口径）；T2/T3 = `countTokens(b.summary)`（注入口径）→ **T1 与 T2/T3 口径不一致，确认问题**
6. **`createCore(ports)`（:962）**：`const countTokens = ports.countTokens ?? defaultCountTokens`，放入 ctx（:125-128），所有 node 可经 `ctx.countTokens` 访问
7. `defaultCountTokens` = CJK-aware：`cjkCount + Math.ceil((len - cjkCount)/4)`（中文 1 字 = 1 token）

### adapter 侧（src/）

1. **`src/runtime.ts` :34** — `createCore({ countTokens: defaultCountTokens })` ← 注入点，改为校准版
2. **`src/index.ts` `wireContextTransform`** — context 事件内已有 `realUsage = ctx.getContextUsage?.()` 和 `estimated = estimateTokens(coreMessages, coveredIds)`（:112-113），tokenCount 优先 realUsage（:114）。**density 更新接入点就在此处**
3. **`src/tokens.ts` `estimateTokens`** — 与 kernel `defaultCountTokens` 一致（CJK-aware），跳过 compress 工具调用 + covered 消息
4. **`src/compress-tool.ts` :57** — `beforeTokens = estimateTokens(...)` 已 CJK-aware

### 修正后的实施清单

**kernel 改动（acp-kernel，上游仓库）**：
- `buildCompressibleRanges` 加 `countTokens` 参数，内部 `estimateMessageTokens(msg)` → `countTokens(msg.text ?? "")`
- `computeProtectedRefs` 同样改用 countTokens（保护区 token 累计也应校准，否则 preserveRecentTokens 语义随密度漂移）
- `recommendNode.run` 传 `ctx.countTokens` 给两处
- 或者更简单：把 `estimateMessageTokens` 的实现直接改成 `countTokens` 语义（但它是模块级函数，无 ctx 访问权，需传参）

**adapter 改动（本仓库）**：
- 新建 `src/density.ts`：EMA 密度估计器（Δreal/Δest、clamp、负增量跳过、session_start 重置）
- `src/runtime.ts`：`createCore({ countTokens: (t) => defaultCountTokens(t) × density })`
- `src/index.ts` context 事件：更新 density（每轮）；tokenCount 逻辑不变
- `src/compress-tool.ts` / `src/status-tool.ts`：beforeTokens/breakdown 统一走校准口径（可选，显示层）

### 待确认问题（实现阶段）

- [ ] density 的 EMA 参数（0.85/0.15）是否需要暴露到 adapter config？
- [ ] `acp_status` breakdown 显示是否也要乘 density？（显示层一致性 vs 模型可读性）
- [ ] 压缩块 summary 的 T2/T3 pending 是否也应该乘 density？（目前方案：不乘，CJK-aware 足够）
- [ ] `computeProtectedRefs` 的 preserveRecentTokens 改用 countTokens 后，保护区大小变化是否影响行为？

## 9. 问题溯源（哪些关键问题由用户提出）

以下关键问题/洞察均由用户提出，推动并塑形了本方案。
**实测环境：DeepSeek V4-Flash（1M 窗口）**，其 tokenizer 中英文密度差异大
（官方 1 英文字符 ≈ 0.3 token vs 1 中文字符 ≈ 0.6 token；实测 1 汉字 ≈ 1.2-1.3 token），
是本方案校准系数的直接动因。

1. **质疑触发时上下文比估算大**（2026-08）：用户观察实际触发时上下文比初版估算大很多，
   要求看当前对话实测 → 暴露了三处口径分裂，是本方案研究的起点。
2. **"为什么不能一开始就从 provider 拿？"**（2026-08）：用户问为什么不能直接用 provider
   真实值而非自算系数 → 澄清了"provider 只给总数、分类求和只能本地算"（§2）。
3. **"系数其实第一轮、第二轮就能开始算了"**（2026-08）：用户指出校准无需等压缩事件，
   第二轮起每轮都能喂样本 → 消除了"预热期"设计（§4）。
4. **"把根因写上，文档里我的问题要注明"**（2026-08）：要求根因显式化 + 问题归属标注
   （本修订）。
