# REQ: 未安装 pi-subagents 时不再向 settings.json 注入 agentOverrides（issue #179）

- Task ID: `2026-08-21_issue179-detect-pi-subagents`
- Home Repo: `billion-context-pi`
- Created: 2026-08-21
- Status: In Progress
- Priority: P1
- References: issue #179

## 1. Background & Problem Statement

- **Context**: `src/setup-subagent-tools.ts` 在每次 session 启动时（`src/index.ts` session_start，fire-and-forget）向 `~/.pi/agent/settings.json` 的 `subagents.agentOverrides` 注入 9 个硬编码 agent（advisor/context-builder/delegate/oracle/planner/researcher/scout/worker）的 ACP 工具白名单。
- **Current behavior (symptom)**: 用户未安装 `pi-subagents`（或只装了不兼容的 fork）时，扩展仍会创建/重建这些 `agentOverrides` 条目；手动删除后下次启动又被写回（issue #179，Windows 用户报告）。旧表还携带 pi-subagents 已不存在的 agent 与过期的 `intercom` 工具。
- **Expected behavior**: 不自动写全局 settings.json；用户显式触发才注入，且 agent 名单与 baseline tools 从安装包自身发现。
- **Impact**: 全局 settings.json 被无主条目污染；用户删除无效且会被重建。

## 2. Reproduction

1. 安装 billion-context-pi，**不**安装 pi-subagents
2. 启动 Pi（任意会话）
3. `~/.pi/agent/settings.json` 出现 `subagents.agentOverrides`（9 个 agent + ACP 工具）
4. 手动删除该块 → 下次启动再次出现

## 3. Constraints & Non-Goals

- 已安装 pi-subagents 时功能必须可用：override `tools` 是**替换**语义（pi-subagents 合并逻辑），必须写完整 baseline + ACP 列表，不能只追加 ACP 四件套（issue 选项 1 单独使用会削弱功能）。
- **设计演进**：第一版做"启动时自动探测 + 自动注入"；评审后改为**显式命令、绝不自动写**——探测必然有洞（git 安装/fork/legacy npm），静默 no-op 比显式一步更难排查；且 #179 根源是"扩展未经同意改全局 settings.json"，自动探测只是缩小爆炸半径、没消除该模式。功能属边际 sugar（长任务 delegate 自管上下文），不值得自动写入。
- 保留既有安全写入机制：`.acp-bak` 备份、mtime 乐观锁、写后校验、失败回滚。
- 不删除用户已有的旧条目（只不动它们）。
- 非目标：git 安装与 legacy global npm 的自动探测（命令支持显式 `<installDir>` 参数覆盖该场景）。

## 4. Acceptance Criteria

- [x] session 启动**不再**触碰 settings.json（删除 session_start 自动调用）
- [x] 新命令 `/acp-subagents [installDir]`：显式触发才写
- [x] 无参数时探测（user/project npm scope + extensions 目录）；未检测到 → 提示安装或传目录，不写
- [x] 显式 `installDir` 覆盖 git/fork 安装；非法目录 → 明确报错
- [x] 按 frontmatter 发现 agent，写 baseline + ACP；无 `tools` frontmatter（无限制 agent）→ 不建条目
- [x] 已有 override tools → 保留原列表补齐 ACP；幂等
- [x] settings.json 缺失 → skipped；JSON 损坏 → failed 且文件不被修改
- [x] README（EN+ZH）文档说明命令用法
