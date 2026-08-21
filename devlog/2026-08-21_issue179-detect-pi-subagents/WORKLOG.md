# WORKLOG: 未安装 pi-subagents 时不再注入 agentOverrides（issue #179）

- Task ID: `2026-08-21_issue179-detect-pi-subagents`
- Home Repo: `billion-context-pi`
- Status: In Progress
- Updated: 2026-08-21

## 1. Summary

- **What was done**: 重写 `src/setup-subagent-tools.ts`——先探测 pi-subagents 安装，再从安装包 `agents/*.md` frontmatter 发现 agent 名单与 baseline tools；未安装则完全不写 settings.json。删除硬编码 `BUILTIN_DEFAULT_TOOLS`（9 agent + 过期 intercom 表）。
- **Why**: pi-subagents 的 `agentOverrides.tools` 合并是替换语义，功能上必须创建完整条目；但无 pi-subagents 时创建条目纯属污染（#179），故选 issue 选项 2（安装探测）+ frontmatter 发现，同时保留功能完整性（选项 1 单独使用会失去为 builtin agent 注入 ACP 的能力）。
- **Behavior / compatibility changes**: 已安装 pi-subagents 的用户行为不变（仍获得 ACP 工具注入，且 baseline 跟随安装包版本更新）；未安装用户不再被写入。`intercom` 不再由本扩展注入（pi-subagents 运行时自行注入 contact_supervisor/intercom bridge）。
- **Risk level**: Low

## 2. Change Log

### Key Files

- `src/setup-subagent-tools.ts` — 重写：新增 `findPiSubagentsInstall(agentDir, cwd)`、`discoverBuiltinAgents(installDir)`、`parseFrontmatterTools()`；`ensureSubagentAcpTools(settingsPath?, options?: {agentDir?, cwd?})`；仅 patch 安装包实际携带的 agent；保留备份/mtime 锁/写后校验/回滚
- `tests/setup-subagent-tools.test.ts` — 重写：13 个测试（fake 包 fixture），覆盖未安装 no-op、三种安装位置探测、stale 条目不重建、merge/幂等/备份/错误路径
- `src/index.ts` — 注释更新（行为说明）
- `devlog/2026-08-21_issue179-detect-pi-subagents/` — REQ.md + WORKLOG.md

## 3. Design & Implementation Notes

- **检测优先级**: ① `<agentDir>/npm/node_modules/pi-subagents` ② `<cwd>/.pi/npm/node_modules/pi-subagents` ③ `<agentDir>/extensions/<name>/package.json` ④ `<cwd>/.pi/extensions/<name>/package.json`（③④ 校验 `name === "pi-subagents"`）。路径与 pi 的 PackageManager（`getManagedNpmInstallPath`、auto-discovered extensions 目录）一致；git 安装与 legacy global npm 不探测（miss = 安全 no-op）。
- **baseline 优先级**: 已有 override `tools`（非空）> frontmatter `tools` > 均无（无限制 agent）→ 跳过不建条目。
- **写后校验**改为只校验发现的 agent（不再硬编码 9 个）。
- **JSDoc 陷阱**: 注释内出现 `*/package.json` 会提前闭合块注释（TS1005）——改用 `<name>/package.json` 表述。

## 4. Testing & Verification

```sh
npm run typecheck   # PASS
npm test            # PASS 387/387（本模块 13/13）
npm run build       # PASS
```

## 5. Follow-ups

- [ ] 发布后回复 issue #179（说明探测范围与 git/legacy 安装不覆盖的边界）
- [ ] 可选：探测 miss 时在 debug 日志记一行原因（当前 `skipped: pi-subagents not installed` 已进 debug.event）
