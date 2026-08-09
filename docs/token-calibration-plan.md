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
  if (postCompressionSkip):                     // 压缩后第一轮跳过（D7/F1）
    postCompressionSkip = false
    return
  Δreal = realTotal - anchorReal                // provider 累计真实增量（同窗口）
  Δest  = estTotal - anchorEst                  // 估算累计增量（同窗口）
  if (Δest >= 50):                              // 最小增量阈值，防微消息比值抖动
    instantDensity = clamp(Δreal / Δest, 0.5, 2.5)
    density = instantDensity                    // 全量比值，无 EMA 滞后
    anchorReal = realTotal; anchorEst = estTotal // 推进锚点
```

压缩触发时设置 `postCompressionSkip = true`（与 §5.1 的 flag 一致）。

然后 `createCore({ countTokens: (text) => defaultCountTokens(text) × density })`。

**为什么用累积锚点法而非 EMA**（评审 D1/D2）：EMA 的 α=0.15 在语言切换
（如中文 1.6 → 英文 0.8）后需 ~20 轮才收敛，期间持续高估 pending；且 Δreal/Δest
存在 off-by-one 时间错位（realUsage 是上一轮 provider 返回值，estimate 是本轮），
工具密集轮会产生虚假尖峰。累积锚点法取同一时间窗口的累计增量，天然对齐、
无滞后、无 α 参数。**推荐加固**（评审 C1）：连续 2 轮比值在 ±20% 内才采纳
（一个 pendingDensity + 确认计数器，成本极低），防单轮异常污染锚点；不影响
收敛速度（正常情况 2 轮确认 = 1 轮延迟）。
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
规则：`if (Δest >= 50) 更新 else 跳过`（Δest 为负的压缩轮自然被跳过）。

## 5. 边界与风险

1. **压缩瞬间 Δest 为负** → `Δest >= 50` 门槛自然跳过；压缩后第一轮正增长可能含残余
   realUsage（provider 在压缩前返回），建议压缩后设置 flag 再跳过一轮（评审 D7）
2. **会话开始无 realUsage** → density 初始 1，第二轮起自然收敛
3. **模型/窗口切换** → `session_start` 重置 density（runtime 已有 `clearNudgeTracking`）；
   **mid-session 模型切换**（如 A 模型 → B 模型）也要重置——不同 tokenizer 的 CJK 密度
   差异巨大（DeepSeek 1.2 vs GPT-4 0.7 vs Claude 0.5），且不同 provider 的 usage 统计
   口径不同（thinking/cache tokens 是否单列），切换后 density 应重新收敛（评审 D6）
4. **per-model 存储** → density 不能是 runtime 全局单值，应为 `Map<modelId, number>`
   （同一个 provider 下有多个模型时各算各的）；并行 session 也要隔离，key 到
   `sessionId × modelId` 粒度（评审 D5）
5. **density clamp [0.5, 2.5]** → 上界从 4 收紧：没有自然语言能达到 4 token/char，
   即使 CJK+emoji 混合也不超过 2.5；下界 0.5 给纯英文留余量（评审 D3）
6. **最小 Δest 阈值 = 50** → 微消息（1-2 字符）的比值极不稳定（评审 D4）
7. **T2/T3 不受影响** → summary 本身短，CJK-aware 已足够
8. **密度不持久化（已知行为）** → density 存内存 Map，Pi 重启后回 1；冷启动
   第 1 轮低估 ~40%，2-3 轮后自动收敛（评审 B1）。不做持久化：收敛快、
   `*.acp.json` 格式改动需向后兼容、冷启动不差于现状（chars/4 本就是当前行为）
9. **provider 连续缺失 realUsage** → 锚点冻结，恢复后累积窗口自动拉长，分子分母
   同比例，比值仍正确。无需"超时重置"逻辑（评审 A1）
## 6. 验证方式

1. 单测：构造中英混合消息，断言 pending = countTokens 口径而非 chars/4
2. 密度模块单测：喂模拟 usage 序列，验证锚点法收敛 + clamp [0.5,2.5] + 最小 Δest 门槛 +
   负增量跳过 + 模型切换重置
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
- **更新测试断言**（F3）：acp-kernel 45 个测试中凡断言 pending/token 数值的用例，从 chars/4 口径改为 CJK-aware 口径（否则 Phase 1 PR 的 CI 会红灯）

**adapter 改动（本仓库）**（⚠️ **依赖 Phase 1 已发布**：若 density 在 kernel chars/4 未修时上线，
Δest 用 chars/4 低基线 → density ≈ 4.8 被 clamp 到 2.5 → 中文注入 2.5 tok/char 高估 2×。
必须 kernel 先发版，Δest 才是 CJK-aware 口径，density 才收敛到 ~1.2 的正确值。评审 B2）：
- 新建 `src/density.ts`：累积锚点密度估计器（Δreal/Δest 同窗口、clamp [0.5,2.5]、
  最小 Δest=50 门槛、压缩后跳过一轮、per-model Map 存储、模型切换重置）
- `src/runtime.ts`：`createCore({ countTokens: (t) => defaultCountTokens(t) × density })`
- `src/index.ts` context 事件：更新 density（每轮）；tokenCount 逻辑不变
- `src/compress-tool.ts` / `src/status-tool.ts`：beforeTokens/breakdown 统一走校准口径（可选，显示层）

### 待确认问题（实现阶段）

- [x] **已决定**：累积锚点法采用"连续 2 轮 ±20% 才采纳"加固（C1 推荐实现，§3.2）
- [x] **已决定**：`acp_status` breakdown **不乘** density——status 显示 kernel 口径（调试视角），
      footer 已显示 provider 真实值，用户有对照
- [x] **已决定**：T2/T3 pending **不乘** density——summary 短，CJK-aware 足够（§5.7）
- [ ] `computeProtectedRefs` 的 preserveRecentTokens 改用 countTokens 后，保护区大小变化是否影响行为？（实现阶段验证）
- [x] **已确认**：runtime 拿 modelId 用 `ctx.model.id`（`src/delegate-tool.ts:562`，完整标识符）

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
5. **"中英文 chars/token 比例不同模型差异大"**（2026-08）：用户指出不同模型 tokenizer
   密度差异（DeepSeek 1.2 vs GPT-4 0.7 vs Claude 0.5），差值法虽自适应，但需 per-model
   存储 + 切换重置 → 补充 §5.3/§5.4（本修订）。

## 10. 独立评审记录（MiMo-V2.5-Pro，2026-08）

评审结论：**有条件通过**。方案方向正确，差值法原理成立，但发现 3 个中风险缺陷 + 4 个
低风险加固项，均已纳入本方案：

| # | 缺陷 | 处置 |
|---|------|------|
| D1 | Δreal/Δest 时间错位（off-by-one），工具密集轮虚高 | §3.2 改用累积锚点法 |
| D2 | EMA α=0.15 粘滞，语言切换 ~20 轮才收敛 | §3.2 锚点法无 α 参数 |
| D3 | clamp 上界 4 过宽 | §5.5 收紧 [0.5, 2.5] |
| D4 | 无最小 Δest 阈值 | §5.6 加 ≥50 门槛 |
| D5 | 并行 session 共享 density | §5.4 per-session×model 存储 |
| D6 | mid-session 模型切换不重置 | §5.3 监听 model 变化重置 |
| D7 | 压缩后第一轮正增长含残余 usage | §5.1 压缩后 flag 跳过一轮 |

评审还建议：**Phase 1（kernel 修复）独立先行**——仅把 `buildCompressibleRanges` 改用
CJK-aware countTokens 就解决 80% 问题（0.25 → 1.0 tok/char，改善 4 倍），零风险可独立
PR；density 系数只是校准残余 ~20% 误差。实施顺序：Phase 1 kernel → Phase 2 adapter
density → Phase 3 显示层。完整评审见 `/tmp/token-calibration-review.md`。

### 第二轮评审（MiMo-V2.5-Pro，2026-08）

结论：**可进入实现阶段**。D1-D7 修订全部到位；`ctx.model.id` 确认可拿模型标识
（`src/delegate-tool.ts:562`）；新增 2 项补救（已纳入 §5/§8）：
- **B1（高）** 密度不持久化，重启回 1 → §5.8 声明为已知行为（收敛 2-3 轮，不做持久化）
- **B2（中）** Phase 2 依赖 Phase 1 先行 → §8 标注：chars/4 未修时 density 会被低基线
  污染（≈4.8 被 clamp 到 2.5，中文高估 2×）
- 建议项：§3.2 ±20% 连续 2 轮确认从可选升为推荐（C1）
完整评审见 `/tmp/token-calibration-review-2.md`。

### 第三轮终审（MiMo-V2.5-Pro，2026-08）

结论：**有条件通过 → 修复 F1/F2 后方案冻结**。核心设计（双层校准 + 累积锚点法 +
per-model 隔离）自洽且可实现。B1/B2/C1 补救到位；D1-D7 全部验证通过。
终审发现 2 处文档内部矛盾（非设计缺陷），已修复：
- **F1（高）** §3.2 算法规范缺 post-compression flag（与 §5.1/D7 描述不一致）→ 伪代码已加
  `if (postCompressionSkip) skip` 逻辑
- **F2（中）** §8 待确认列表与正文矛盾（±20% 推荐 vs 可选、T2/T3 定论 vs 待确认）→ 已对齐，
  已决定项标注 [x]
- 建议项：F3 kernel 测试断言同步更新（已入 §8 清单）
额外确认：density 的 estTotal 来自 adapter `estimateTokens`（本就 CJK-aware），B2 的
发布顺序约束是预防性保障而非运行时崩溃风险；F4/F5/F6 均验证无阻塞。
完整评审见 `/tmp/token-calibration-review-3.md`。
