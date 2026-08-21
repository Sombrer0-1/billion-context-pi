# WORKLOG: 自动更新在无法直连 npmjs 的机器上静默失效

- Task ID: `2026-08-21_update-check-robustness`
- Home Repo: `billion-context-pi`
- Status: InProgress
- Updated: 2026-08-21 14:10

## 1. Summary

- **What was done**: 版本检查改走 `npm view` 优先（尊重本机 registry/proxy 配置），直接 fetch 降为回退（超时 5s→10s）；安装失败日志补 npm stderr，新增 install-skip 原因日志；headless 模式（print/rpc/json）的 session_start 与 context 处理器改为 await 更新检查，进程退出不再杀掉进行中的安装；新增 `runNpm` execFile 封装 + 测试 seam。
- **Why**: 只能经镜像/代理访问 npm 的机器上，直连 registry.npmjs.org 的 fetch 失败（Node fetch 不认 proxy 环境变量），新版本永远检测不到；安装失败静默导致无法排查；headless 进程 turn 结束即退出，fire-and-forget 的检查/安装被连带杀掉（用户机器 0.1.40→0.1.41、0.1.38→0.1.41 的静默失败与此吻合）。
- **Behavior / compatibility changes**: Yes——有 npm 的机器检查走 `npm view`（与安装同工具链）；无 npm 的机器行为不变（fetch 回退）；headless 进程在更新检查/安装期间保持存活（TUI 不变，仍 fire-and-forget）；新增日志事件（`check-fetch-error`/`auto-install-failed`/`install-skip`）。
- **Risk level**: Low

## 2. Change Log

### Commits

| Commit | Description |
|--------|-------------|
| `0173f55` | fix(update): check latest via npm view, log install failures |
| `f7378f0` | fix(update): await update check in headless mode so process exit cannot kill an in-flight install |
| `a3782f2` | test: isolate update-check throttle file across parallel test processes |
| (next) | fix(update): verify installs and roll back broken publishes (anti-brick) |

### Key Files

- `src/update.ts` — +74/-13：新增 `NpmRunner` 类型 + `runNpm`（execFile 封装，捕获 stdout/stderr，maxBuffer 4MB，win32 走 shell）+ `setRunNpmForTest` seam；`fetchLatestVersion()`（npm view 20s → fetch 10s 回退，SEMVER_RE 校验输出）；`autoInstallLatest` 改走 `runNpm`，失败记 `auto-install-failed`（stderr 尾部 2000 字符）、跳过记 `install-skip`（reason）；导出 `isNewer`
- `src/index.ts` — +9/-2：session_start 与 context 两个调用点由 `void checkForUpdate(...)` 改为 `if (!ctx.hasUI) await updateCheck`——headless（print/rpc/json）进程在 turn 结束后即退出，fire-and-forget 会把进行中的 npm install 杀掉；TUI 保持 fire-and-forget 不阻塞交互
- `tests/update.test.ts` — 重写，17 个测试：opt-out 短路（npm+fetch 双守卫）、`isNewer` 数值比较、`runNpm` 真实 npm 成功/stderr 捕获、checkForUpdate 全路径（npm view 参数 / install-skip / fetch 回退 / 双失败 / non-OK / 节流）、autoInstallLatest 安装路径（fixture 布局：验证通过 → ok / 语法坏入口 → 回滚上一版本 / npm 失败 → failed 不回滚不验证）
- `tests/integration.test.ts` — +119：模块级 `setRunNpmForTest` 假 runner（headless 测试现在会 await 检查，必须 hermetic，防真实网络调用）；新增 2 个测试：headless 处理器在检查进行中（npm view 挂起）必须保持 pending、view 解析后随检查完成而结算（日志断言 `event=check latest=99.0.0 hasUpdate=true` + `install-skip`）；TUI 处理器在检查进行中立即结算

## 3. Design & Implementation Notes

- **Entry point / key function**: `fetchLatestVersion`（`src/update.ts:156`）、`autoInstallLatest`（`src/update.ts:116`）、`checkForUpdate`（`src/update.ts:196`）
- **保留 fetch 回退的原因**: 无 npm 的机器上直连 fetch 仍是唯一检测通道；超时放宽到 10s 降低慢网络误报

### Anti-brick hardening (2026-08-21 14:10)

- **风险**: npm exit 0 只代表 tarball 解压成功，不代表扩展能加载。坏发布（缺 dist / 语法错误 / ABI 断裂）装上后，下次重启 pi 加载失败 → 扩展不再运行 → 永远无法自更新回健康版本 = **永久砖死**（用户断联）。原先 `autoInstallLatest` 只看 exit code。
- **修复**: 安装后 `verifyInstall()`——读 `node_modules/billion-context-pi/package.json` 校验 version 匹配 + 声明入口（`pi.extensions[0]` / `exports["."].import` / `main`，去重）全部存在，再用子进程 `node -e` + `pathToFileURL` 真实 smoke-import 入口（15s 超时，Windows 盘符安全）。失败 → 回滚安装前版本（`--no-save`，不动宿主 package.json/lockfile），返回 `rolled-back` 并 notify 用户（不再给出会手动砖死的手动安装提示）。
- **通知分派**: `ok` → 绿色 "auto-updated … Restart Pi"；`rolled-back` → 黄色 "failed verification and was rolled back"；`failed` → 原有手动安装提示。
- **测试 seam**: `NodeRunner`/`runNode`/`setRunNodeForTest`（对齐 runNpm 模式）；`autoInstallLatest(latest, extDirOverride?)` 第二参数专供测试 fixture（真实测试进程不在 node_modules 下，原路径不可达）。
- **测试隔离**: 测试进程把 `HOME` 指到临时目录（`THROTTLE_FILE` 是模块级常量，import 前必须设置）、`ACP_LOG_FILE` 同指临时目录；真实 npm 测试临时还原真实 HOME（npm 解析可能依赖 HOME，如 nvm 布局或 npm 包装脚本）
