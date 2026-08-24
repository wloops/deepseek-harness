# @deepseek-ai/dsh-desktop

[English](README.md) | 中文

一个 Electron 桌面壳，通过本地派生的 `dsh web` 服务器承载 DeepSeek Harness Web GUI。壳是薄宿主：它只管理服务器子进程与窗口，自身不携带任何前端或服务器代码。

## 工作原理

Web GUI 不是独立前端。dsh 宿主伺服构建好的 SPA，并在响应 index.html 时注入 `window.__DSH_BOOT__` 启动图；页面通过 `/api` HTTP RPC 与两条 WebSocket 下行流与宿主通信。桌面壳无法单独打包前端，必须运行服务器。

因此壳从仓库根派生 `node --import tsx/esm apps/cli/src/bin.ts web --port 0`（[源码启动契约](../../docs/development.zh.md)），等待服务器在 stdout 打印 `dsh web: http://127.0.0.1:<port>` 就绪行，然后在 Electron 窗口中加载该 URL。环回地址天然通过 `/api` 信任围栏，前后端代码零改动。按 CLI 策略，服务器只绑定环回地址。

## 运行

前置条件：仓库已安装（`pnpm install`）并构建（`pnpm run build`，产出前端 dist 与本包的 `lib/types/main.js`）。

```sh
pnpm --filter @deepseek-ai/dsh-desktop start
```

壳默认将仓库根定位为构建产物（tsc 的 `lib/types` 输出目录）之上四级，并以 `apps/cli/package.json` 验证；其他布局用 `DSH_REPO_ROOT` 指定：

```sh
$env:DSH_REPO_ROOT = "D:\path\to\deepseek-harness"   # PowerShell
pnpm --filter @deepseek-ai/dsh-desktop start
```

`DSH_DESKTOP_SMOKE=1` 会在窗口首次渲染几秒后退出应用，用于无人值守地验证整条链路。服务器日志以 `[dsh]` 前缀转发到 Electron 主进程控制台。

## 多机工作流

仓库维护两个长期分支：`master` 只用于跟踪上游 `deepseek-ai/deepseek-harness` 仓库的更新，`desktop` 承载本壳的改动，是日常工作分支。在 GitHub 上 fork 上游仓库，把 `desktop` 推送到 fork，然后在每一台需要运行本壳的机器上 clone 该 fork。

单台机器的首次设置：

```sh
git clone git@github.com:<you>/deepseek-harness.git
cd deepseek-harness
git checkout desktop
pnpm install
pnpm run build
pnpm --filter @deepseek-ai/dsh-desktop start
```

跟随上游更新：

```sh
git checkout master
git pull origin master
git checkout desktop
git rebase master
pnpm install && pnpm run build
```

rebase 后 `pnpm-lock.yaml` 冲突时重新运行 `pnpm install` 解决，绝不手工合并。`pnpm install` 期间 Electron 二进制下载缓慢时，用更长的抓取超时重试（`pnpm install --fetch-timeout 1200000`）。

## 生命周期

| 事件 | 行为 |
|---|---|
| 启动 | 在 OS 分配的环回端口上派生 dsh web 服务器；等待就绪行（90 秒超时）。 |
| 关窗 | 退出应用并杀死服务器进程树（Windows 上 `taskkill /T /F`）。 |
| 服务器崩溃 | 自动重启，最多连续 3 次，之后弹出错误框并退出。 |
| 二次启动 | 单实例锁：聚焦已有窗口，绝不启动第二个服务器。 |
| 下载 | 原生保存对话框（与浏览器一致；Electron 默认静默存入下载目录）。 |
| 外链 | 交给系统浏览器打开。 |

## 已知限制

- 桌面端与浏览器 `dsh web` 两个实例共享同一 `$DSH_HOME` 文件存储；请同时只运行一个。
- 打包分发（electron-builder 安装包、内置服务器二进制）尚未完成；当前壳从检出目录运行。
- Electron 的 postinstall 会下载二进制；工作区 `allowBuilds` 条目已登记它，CI 每次安装都会下载。
