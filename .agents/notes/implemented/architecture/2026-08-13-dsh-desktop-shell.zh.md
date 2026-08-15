# Agent Note: dsh-desktop 壳通过 sidecar dsh web 服务器承载 Web GUI

Status: implemented

[English](2026-08-13-dsh-desktop-shell.md) | 中文

## 问题

Web GUI 不是独立前端：dsh 宿主伺服构建好的 SPA，并在响应 index.html 时注入 `window.__DSH_BOOT__` 启动图；页面通过 `/api` HTTP RPC 与两条 WebSocket 下行流与宿主通信。桌面应用无法单独打包前端；服务器必须运行，桌面壳必须管理其生命周期。

## 决策

`apps/desktop` 是一个 Electron 主进程：以子进程方式派生真实的 `dsh web` 服务器（`node --import tsx/esm apps/cli/src/bin.ts web --port 0`，环回绑定，OS 分配端口），从 stdout 解析服务器的 `dsh web: http://127.0.0.1:<port>` 就绪行，然后在沙箱化 BrowserWindow 中加载该 URL。环回地址天然通过 `/api` 信任围栏，前后端代码零改动。

壳拆分为纯 Node 的 `server-manager.ts`（派生工厂注入、按行缓冲、就绪解析、启动超时、崩溃重启、幂等停止）与薄 Electron 胶水 `main.ts`（窗口、单实例锁、下载、外链）。测试用内联 `node -e` 子进程演练真实进程生命周期；GUI 冒烟通过 `DSH_DESKTOP_SMOKE=1` 在本地运行，不进 CI。

包以 `@deepseek-ai/dsh-desktop` 身份加入工作区（`tsconfig.host.json` 的 tsc reference、`pnpm-workspace.yaml` `allowBuilds` 中的 `electron` 条目）。它对仓库的契约依赖是 CLI 入口路径、就绪行格式与 `--port 0` 语义；契约变更以启动超时对话框暴露，绝不静默失败。

## 备选方案

- **在 Electron 主进程中内嵌服务器**（进程内 import CLI）：拒绝——与宿主进程版本强耦合、崩溃会连 UI 一起挂、退出时的 Cordis 清理必须正确；子进程让两个表面相互独立。
- **用 Tauri 替代 Electron**：拒绝——对本壳而言，WebView2/JavaScript 互操作与 Rust 工具链的额外成本抵不上更小的体积。
- **单独分发构建好的前端**（例如从磁盘加载 dist）：拒绝——`window.__DSH_BOOT__` 由服务器在请求时注入；没有宿主，壳无法启动。

## 后果

- 跟随上游更新就是常规流程：`git pull`、`pnpm install`、`pnpm run build`、`pnpm --filter @deepseek-ai/dsh-desktop start`。
- 桌面实例与浏览器 `dsh web` 实例共享 `$DSH_HOME` 文件存储；请同时只运行一个。
- 打包分发（带内置服务器的 electron-builder 安装包）推迟；壳当前从检出目录运行。
- 桌面壳通过 tsx 从源码派生 CLI，因此完整仓库构建（含前端 dist）是前置条件。
