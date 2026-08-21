# WORKLOG: 未安装 pi-subagents 时不再注入 agentOverrides（issue #179）

- Task ID: `2026-08-21_issue179-detect-pi-subagents`
- Home Repo: `billion-context-pi`
- Status: In Progress
- Updated: 2026-08-21

## 1. Summary

- **What was done**: 删除 session_start 自动注入；改为一次性命令 `/acp-subagents [installDir]` 显式触发。`src/setup-subagent-tools.ts` 保留探测 + frontmatter 发现（`agents/*.md`）+ 安全写入机制；删除硬编码 `BUILTIN_DEFAULT_TOOLS`（9 agent + 过期 intercom 表）与 `runSetupAndNotify`。
- **Why**: pi-subagents 的 `agentOverrides.tools` 是替换语义，注入必须写完整条目；但自动写入是 #179 的根源（"扩展未经同意改全局 settings.json"）。自动探测方案探测有洞（git/fork/legacy npm，含报告者的 fork）且耦合 pi-subagents 内部布局；显式命令把写入变成用户动作，miss 是可见报错而非静默 no-op，frontmatter 运行时发现使文档永不腐化。
- **Behavior / compatibility changes**: 所有用户：settings.json 不再被自动写入（已有条目保留不动，零影响）；想给 pi-subagents 子代理 ACP 工具的用户需跑一次 `/acp-subagents`（升级 pi-subagents 后再跑）。
- **Risk level**: Low

## 2. Change Log

### Key Files

- `src/setup-subagent-tools.ts` — 重写：`findPiSubagentsInstall(agentDir, cwd)`、`discoverBuiltinAgents(installDir)`、`parseFrontmatterTools()`；`ensureSubagentAcpTools(settingsPath?, options?: {agentDir?, cwd?, installDir?})`——`installDir` 显式指定时跳过探测（校验 package.json 存在）；删除 `runSetupAndNotify`；保留备份/mtime 锁/写后校验/回滚
- `src/index.ts` — 删除 session_start 的 `runSetupAndNotify` 自动调用与 import
- `src/commands.ts` — 新增 `/acp-subagents [installDir]` 命令（updated/skipped/failed 三态通知文案）
- `tests/setup-subagent-tools.test.ts` — 重写：15 个测试（fake 包 fixture），覆盖未安装 no-op、三种安装位置探测、显式 installDir、stale 条目不重建、merge/幂等/备份/错误路径
- `README.md` / `README.zh-CN.md` — 新增 `/acp-subagents` 命令小节（可选、一次性、唯一写入路径）
- `devlog/2026-08-21_issue179-detect-pi-subagents/` — REQ.md + WORKLOG.md

## 3. Design & Implementation Notes

- **检测优先级（无参数时）**: ① `<agentDir>/npm/node_modules/pi-subagents` ② `<cwd>/.pi/npm/node_modules/pi-subagents` ③ `<agentDir>/extensions/<name>/package.json` ④ `<cwd>/.pi/extensions/<name>/package.json`（③④ 校验 `name === "pi-subagents"`）。git/legacy 安装不自动探测 → 命令的 `<installDir>` 参数兜底。
- **baseline 优先级**: 已有 override `tools`（非空）> frontmatter `tools` > 均无（无限制 agent）→ 跳过不建条目。
- **JSDoc 陷阱**: 注释内出现 `*/package.json` 会提前闭合块注释（TS1005）——改用 `<name>/package.json` 表述。

## 4. Testing & Verification

```sh
npm run typecheck   # PASS
npm test            # PASS（本模块 15/15）
npm run build       # PASS
```

## 5. Follow-ups

- [ ] PR #183 描述与 issue #179 留言需更新为最终方案（显式命令，非自动探测）
- [ ] 发布后跟进 issue #179
