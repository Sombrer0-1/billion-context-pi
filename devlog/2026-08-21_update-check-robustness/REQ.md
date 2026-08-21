# REQ: 自动更新在无法直连 npmjs 的机器上静默失效

- Task ID: `2026-08-21_update-check-robustness`
- Home Repo: `billion-context-pi`
- Created: 2026-08-21
- Status: InProgress
- Priority: P1
- Owner: ework-daemon
- References: issue dog/billion-context-pi#8

## 1. Background & Problem Statement

- **Context**: 自动更新分两步——版本检查（直接 `fetch https://registry.npmjs.org/billion-context-pi/latest`，5s 超时，不走任何 npm 配置）+ 自动安装（`npm install billion-context-pi@<ver>`）。
- **Current behavior (symptom)**: 部分机器上自动更新静默失效。Node 全局 fetch 不认 `HTTP_PROXY`/`HTTPS_PROXY`，走国内镜像（npmmirror）或企业代理的机器直连 registry.npmjs.org 超时/失败，**根本检测不到新版本**；且安装失败完全静默（仅 TUI 提示、无日志），无法排查。
- **Expected behavior**:
  - 版本检查优先走 `npm view billion-context-pi version`（尊重本机 registry/proxy/auth 配置，与安装步同一工具链）；npm 不可用时回退直接 registry fetch。
  - 安装失败/跳过原因写入 `~/.pi/acp.log`（含 npm stderr），可诊断。
  - headless 模式（print/rpc/json）下 session_start / context 处理器 await 更新检查，进程退出不会杀掉进行中的 npm install；TUI 保持 fire-and-forget。
- **Impact**: 无数据丢失、无崩溃；补齐受影响机器"检测不到新版本"的缺口；不受影响机器行为等价（保留 fetch 回退）。

## 2. Reproduction (if applicable)

- **Environment**:
  - Node: 22+
  - OS/Arch: linux-x64 / win32-x64
- **Minimal reproduction steps**:
  1) 在 `npm config get registry` 为镜像（或需代理）的机器上，阻断到 registry.npmjs.org 的直连
  2) 启动 Pi，等待更新检查 → `~/.pi/acp.log` 出现 `event=check-error`（fetch 超时）
  3) npm 本身完全可用，但插件检测不到新版本
- **Relevant configuration**: `~/.npmrc`（registry/proxy）、`ACP_AUTO_UPDATE`

## 3. Constraints & Non-Goals

- **Constraints**:
  - 不引入新运行时依赖
  - 3 分钟检查节流与 opt-out 语义（env/config）不变
  - `npm install` 安全参数数组方式（不拼 shell 字符串）不变
- **Non-Goals**: 不修 headless 模式无 UI 提示（headless 本无 UI，日志即诊断通道）；不做安装重试

## 4. Acceptance Criteria (must be testable)

- **Correctness**:
  - [x] 检查优先 `npm view`（args `["view","billion-context-pi","version"]`）；失败回退直接 registry fetch
  - [x] 两者皆失败 → 不崩溃、无提示，日志 `event=check-fetch-error`
  - [x] 安装失败 → 日志 `event=auto-install-failed`（含 npm stderr）；跳过 → `event=install-skip`（含 reason）
  - [x] opt-out（env/config）在任何 npm/fetch 调用前短路
  - [x] `isNewer` 数值比较（0.2.0 不新于 0.10.0）
- **Compatibility**:
  - [x] 既有 384 个测试全部通过（本次后共 393）
  - [x] typecheck / build 通过
