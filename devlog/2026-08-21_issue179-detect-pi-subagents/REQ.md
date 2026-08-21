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
- **Expected behavior**: 仅当检测到已安装的 pi-subagents 时才注入；注入的 agent 名单与 baseline tools 从安装包自身的 `agents/*.md` frontmatter 发现，而非硬编码。
- **Impact**: 全局 settings.json 被无主条目污染；用户删除无效且会被重建。

## 2. Reproduction

1. 安装 billion-context-pi，**不**安装 pi-subagents
2. 启动 Pi（任意会话）
3. `~/.pi/agent/settings.json` 出现 `subagents.agentOverrides`（9 个 agent + ACP 工具）
4. 手动删除该块 → 下次启动再次出现

## 3. Constraints & Non-Goals

- 已安装 pi-subagents 时，功能必须保持可用：override `tools` 是**替换**语义（pi-subagents `src/agents/agents.ts` 合并逻辑），因此必须写完整 baseline + ACP 列表，不能只追加 ACP 四件套（issue 选项 1 单独使用会削弱功能）。
- 保留既有安全写入机制：`.acp-bak` 备份、mtime 乐观锁、写后校验、失败回滚。
- 不删除用户已有的旧条目（只不动它们）；不清理 `*.acp-bak`。
- 非目标：不支持 git 安装与 legacy global npm 路径的探测（miss = 安全 no-op，不注入）。

## 4. Acceptance Criteria

- [x] 未检测到 pi-subagents → 不读改写 settings.json，无备份文件，stale 条目原样保留
- [x] 检测到（user-scope `<agentDir>/npm/node_modules` / project-scope `<cwd>/.pi/npm/node_modules` / extensions 目录）→ 按 frontmatter 发现 agent，写 baseline + ACP
- [x] frontmatter 无 `tools`（无限制 agent）→ 不创建条目
- [x] 已有 override tools（用户自定义或含部分 ACP）→ 保留原列表并补齐 ACP
- [x] 幂等：第二次运行 skipped（`already have ACP tools`）
- [x] settings.json 缺失 → skipped；JSON 损坏 → failed 且文件不被修改
