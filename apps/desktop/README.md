# @deepseek-ai/dsh-desktop

English | [中文](README.zh.md)

An Electron desktop shell that hosts the DeepSeek Harness Web GUI over a locally spawned `dsh web` server. The shell is a thin host: it owns the server child process and the window, and ships no frontend or server code of its own.

## How it works

The Web GUI is not a standalone frontend. The dsh host serves the built SPA and injects the `window.__DSH_BOOT__` entry graph into index.html at request time, and the page talks to the host over `/api` HTTP RPC plus two WebSocket downlinks. A desktop shell cannot bundle the frontend alone; it must run the server.

The shell therefore spawns `node --import tsx/esm apps/cli/src/bin.ts web --port 0` from the repository root ([source-launch contract](../../docs/development.md)), waits for the server's `dsh web: http://127.0.0.1:<port>` readiness line on stdout, and loads that URL in an Electron window. Loopback passes the `/api` trust fence unchanged, so no frontend or server code changes. The server bind is loopback-only by CLI policy.

## Running

Prerequisites: the repository is installed (`pnpm install`) and built (`pnpm run build`, which emits the frontend dist and this package's `lib/types/main.js`).

```sh
pnpm --filter @deepseek-ai/dsh-desktop start
```

The shell locates the repository root as four hops above the built main (the tsc `lib/types` outDir) and verifies it by `apps/cli/package.json`; a different layout sets `DSH_REPO_ROOT`:

```sh
$env:DSH_REPO_ROOT = "D:\path\to\deepseek-harness"   # PowerShell
pnpm --filter @deepseek-ai/dsh-desktop start
```

`DSH_DESKTOP_SMOKE=1` quits the app a few seconds after the window's first paint, for automated verification of the whole chain without a human closing the window. Server logs are forwarded to the Electron main process console with a `[dsh]` prefix.

## Lifecycle

| Event | Behavior |
|---|---|
| Start | Spawn the dsh web server on an OS-assigned loopback port; wait for the readiness line (90 s timeout). |
| Window close | Quit the app and kill the server process tree (`taskkill /T /F` on Windows). |
| Server crash | Restart automatically, up to 3 consecutive crashes, then show an error dialog and quit. |
| Second launch | Single-instance lock: focus the existing window, never a second server. |
| Downloads | Native save dialog (browser parity; Electron otherwise drops silently into Downloads). |
| External links | Opened in the system browser. |

## Known limitations

- Two instances (desktop and browser `dsh web`) share the same `$DSH_HOME` file storage; run one at a time.
- The packaged distribution (electron-builder installer, bundled server binary) is not built yet; the shell runs from the checkout.
- Electron's postinstall downloads its binary; the workspace `allowBuilds` entry lists it, and CI installs it on every run.
