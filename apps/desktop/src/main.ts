/**
 * dsh-desktop — Electron main process.
 *
 * The Web GUI is not a standalone frontend: the dsh host serves the built SPA
 * and injects the `window.__DSH_BOOT__` entry graph into index.html, and the
 * page talks to it over `/api` HTTP RPC plus two WebSocket downlinks. The
 * desktop shell therefore keeps the architecture intact: it spawns a local
 * `dsh web` server child process (loopback bind only, OS-assigned port),
 * waits for the server's `dsh web: http://...` readiness line on stdout, then
 * hosts that URL in an Electron window. Loopback passes the `/api` trust
 * fence unchanged, so no frontend or server code changes.
 *
 * Lifecycle: the server dies when the window closes (process tree killed on
 * Windows), restarts automatically after a crash up to MAX_RESTARTS, and a
 * second instance focuses the existing window instead of starting a second
 * server (two instances would race on the same DSH_HOME storage).
 */

import { app, BrowserWindow, dialog, shell, session } from 'electron'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ServerManager } from './server-manager.ts'

/**
 * Repository root hosting the dsh CLI and the built frontend dist. The
 * default assumes the tsc outDir `lib/types/` (four hops up); layouts that
 * do not hold override with DSH_REPO_ROOT.
 */
const REPO_ROOT = process.env.DSH_REPO_ROOT
  ?? resolve(fileURLToPath(new URL('../../../..', import.meta.url)))

/** The dsh CLI dispatch entry, launched through tsx (the repo's source-launch contract). */
const CLI_ARGS = ['--import', 'tsx/esm', 'apps/cli/src/bin.ts', 'web', '--port', '0']

/** How long the dsh server may take to print its readiness line. */
const BOOT_TIMEOUT_MS = 90_000

/** Consecutive server crashes before giving up with an error dialog. */
const MAX_RESTARTS = 3

/** Matches the readiness line printed by the web-app bundle, e.g. `dsh web: http://127.0.0.1:54321`. */
const READY_RE = /dsh web: (http:\/\/\S+)/u

let mainWindow: BrowserWindow | null = null
let server: ServerManager | null = null

/** Kill a process tree: taskkill on Windows, SIGTERM then SIGKILL elsewhere. */
function killTree(proc: ChildProcess): void {
  if (proc.exitCode !== null || proc.signalCode !== null) return
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true })
  } else {
    proc.kill('SIGTERM')
    setTimeout(() => {
      if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL')
    }, 2000).unref()
  }
}

/** Point the existing window at a (new) server URL, or create it when absent. */
function showWindow(webUrl: string): void {
  if (mainWindow !== null && !mainWindow.isDestroyed()) {
    void mainWindow.loadURL(webUrl)
    return
  }
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  mainWindow = win
  win.once('ready-to-show', () => {
    win.show()
    // Smoke hook: DSH_DESKTOP_SMOKE=1 quits shortly after the first paint, so
    // automated runs verify the whole chain without a human closing the window.
    if (process.env.DSH_DESKTOP_SMOKE === '1') setTimeout(() => { app.quit() }, 3000)
  })
  win.webContents.on('did-fail-load', (_event, code, description) => {
    console.error(`[window] load failed (${code}): ${description}`)
  })
  // External links open in the system browser; nothing ever spawns a second window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.on('closed', () => {
    mainWindow = null
  })
  void win.loadURL(webUrl)
}

/** Spawn the local dsh web server and wire the window to its readiness URL. */
function boot(): void {
  server = new ServerManager({
    spawn,
    command: 'node',
    args: CLI_ARGS,
    cwd: REPO_ROOT,
    readyPattern: READY_RE,
    bootTimeoutMs: BOOT_TIMEOUT_MS,
    maxRestarts: MAX_RESTARTS,
    killTree,
    onLine: (line) => { console.log('[dsh]', line) },
    onErrorLine: (line) => { console.log('[dsh:err]', line) },
    onReady: (url) => { showWindow(url) },
    onExit: ({ code, signal, restarts }) => {
      console.log(`[dsh] server exited (code ${String(code)}, signal ${String(signal)}); restart ${restarts}/${MAX_RESTARTS}`)
    },
    onGiveUp: (reason) => {
      const body = reason === 'timeout'
        ? `The dsh web server did not print its URL within ${Math.round(BOOT_TIMEOUT_MS / 1000)}s.\n\n`
          + `Check that ${REPO_ROOT} is installed (pnpm install) and built (pnpm run build).`
        : `The dsh web server exited ${MAX_RESTARTS} times in a row. See the console output above.`
      dialog.showErrorBox('dsh-desktop: server failed to boot', body)
      app.quit()
    },
  })
  server.start()
}

// Guard against a wrong default layout before the app tries to boot a server.
if (!existsSync(resolve(REPO_ROOT, 'apps', 'cli', 'package.json'))) {
  console.error(`dsh-desktop: ${REPO_ROOT} is not a deepseek-harness checkout (missing apps/cli/package.json); set DSH_REPO_ROOT.`)
  app.exit(1)
}

// Single instance: a second launch focuses the existing window instead of
// starting a second server (two instances would race on the same DSH_HOME).
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow !== null && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })
  void app.whenReady().then(() => {
    // Browser-parity downloads: ask where to save instead of Electron's
    // default silent drop into the Downloads folder. Electron 43 returns the
    // chosen path directly; an empty string means the dialog was cancelled.
    session.defaultSession.on('will-download', (event, item) => {
      const win = BrowserWindow.getFocusedWindow() ?? mainWindow
      if (win === null) return
      const result = dialog.showSaveDialogSync(win, { defaultPath: item.getFilename() })
      if (result !== '') item.setSavePath(result)
      else event.preventDefault()
    })
    boot()
  })
  app.on('window-all-closed', () => { app.quit() })
  app.on('before-quit', () => { server?.stop() })
}
