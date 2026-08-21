# WORKLOG: 自动更新在无法直连 npmjs 的机器上静默失效

- Task ID: `2026-08-21_update-check-robustness`
- Home Repo: `billion-context-pi`
- Status: InProgress
- Updated: 2026-08-21 12:55

## 1. Summary

- **What was done**: 版本检查改走 `npm view` 优先（尊重本机 registry/proxy 配置），直接 fetch 降为回退（超时 5s→10s）；安装失败日志补 npm stderr，新增 install-skip 原因日志；新增 `runNpm` execFile 封装 + 测试 seam。
- **Why**: 只能经镜像/代理访问 npm 的机器上，直连 registry.npmjs.org 的 fetch 失败（Node fetch 不认 proxy 环境变量），新版本永远检测不到；安装失败静默导致无法排查。
- **Behavior / compatibility changes**: Yes——有 npm 的机器检查走 `npm view`（与安装同工具链）；无 npm 的机器行为不变（fetch 回退）；新增日志事件（`check-fetch-error`/`auto-install-failed`/`install-skip`）。
- **Risk level**: Low

## 2. Change Log

### Commits

| Commit | Description |
|--------|-------------|
| `0173f55` | fix(update): check latest via npm view, log install failures |

### Key Files

- `src/update.ts` — +74/-13：新增 `NpmRunner` 类型 + `runNpm`（execFile 封装，捕获 stdout/stderr，maxBuffer 4MB，win32 走 shell）+ `setRunNpmForTest` seam；`fetchLatestVersion()`（npm view 20s → fetch 10s 回退，SEMVER_RE 校验输出）；`autoInstallLatest` 改走 `runNpm`，失败记 `auto-install-failed`（stderr 尾部 2000 字符）、跳过记 `install-skip`（reason）；导出 `isNewer`
- `tests/update.test.ts` — 重写，14 个测试：opt-out 短路（npm+fetch 双守卫）、`isNewer` 数值比较、`runNpm` 真实 npm 成功/stderr 捕获、checkForUpdate 全路径（npm view 参数 / install-skip / fetch 回退 / 双失败 / non-OK / 节流）

## 3. Design & Implementation Notes

- **Entry point / key function**: `fetchLatestVersion`（`src/update.ts:156`）、`autoInstallLatest`（`src/update.ts:116`）、`checkForUpdate`（`src/update.ts:196`）
- **保留 fetch 回退的原因**: 无 npm 的机器上直连 fetch 仍是唯一检测通道；超时放宽到 10s 降低慢网络误报
- **测试隔离**: 测试进程把 `HOME` 指到临时目录（`THROTTLE_FILE` 是模块级常量，import 前必须设置）、`ACP_LOG_FILE` 同指临时目录；真实 npm 测试临时还原真实 HOME（npm 解析可能依赖 HOME，如 nvm 布局或 npm 包装脚本）
