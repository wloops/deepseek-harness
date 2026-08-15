# Agent Note: dsh-desktop shell hosts the Web GUI over a sidecar dsh web server

Status: implemented

English | [中文](2026-08-13-dsh-desktop-shell.zh.md)

## Problem

The Web GUI is not a standalone frontend: the dsh host serves the built SPA and injects the `window.__DSH_BOOT__` entry graph into index.html, and the page talks to the host over `/api` HTTP RPC plus two WebSocket downlinks. A desktop app cannot bundle the frontend alone; the server must run, and the desktop shell must own its lifecycle.

## Decision

`apps/desktop` is an Electron main process that spawns the real `dsh web` server as a child process (`node --import tsx/esm apps/cli/src/bin.ts web --port 0`, loopback bind, OS-assigned port), resolves the server's `dsh web: http://127.0.0.1:<port>` readiness line from stdout, and loads that URL in a sandboxed BrowserWindow. Loopback passes the `/api` trust fence unchanged, so no frontend or server code changes.

The shell splits into a pure-Node `server-manager.ts` (spawn factory injection, line buffering, readiness resolution, boot timeout, crash restarts, idempotent stop) and a thin Electron `main.ts` (window, single-instance lock, downloads, external links). The tests exercise the real process lifecycle with inline `node -e` children; a GUI smoke runs locally through `DSH_DESKTOP_SMOKE=1` and is not in CI.

The package joins the workspace as `@deepseek-ai/dsh-desktop` (tsc reference in `tsconfig.host.json`, `electron` listed in `pnpm-workspace.yaml` `allowBuilds`). Its contract dependencies on the repo are the CLI entry path, the readiness line format, and `--port 0` semantics; a contract change surfaces as a boot-timeout dialog, never a silent failure.

## Alternatives considered

- **Embed the server in the Electron main process** (import the CLI in-process): rejected — version coupling to the host process, a crash takes the UI with it, and Cordis teardown on quit must be correct; a child process keeps the surfaces independent.
- **Tauri instead of Electron**: rejected — the WebView2/JavaScript interoperability and Rust toolchain overhead were not worth the smaller binary for this shell.
- **Ship the built frontend standalone** (e.g. load dist from disk): rejected — `window.__DSH_BOOT__` is injected by the server at request time; without the host the shell cannot boot.

## Consequences

- Following upstream is the ordinary flow: `git pull`, `pnpm install`, `pnpm run build`, `pnpm --filter @deepseek-ai/dsh-desktop start`.
- The desktop instance and a browser `dsh web` instance share `$DSH_HOME` file storage; run one at a time.
- Packaged distribution (electron-builder installer with a bundled server) is deferred; the shell runs from the checkout.
- The desktop shell spawns the CLI from source through tsx, so a full repository build (frontend dist included) is a prerequisite.
