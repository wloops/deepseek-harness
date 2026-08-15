/**
 * Server lifecycle for the dsh-desktop shell: spawns the dsh web server child
 * process, resolves its readiness line from stdout, restarts after crashes,
 * and stops it. The module is pure Node (no Electron imports) so the tests
 * exercise the real process lifecycle without a GUI.
 */

import { spawn, type ChildProcess } from 'node:child_process'

/** One server exit, with the consecutive-crash count before this exit. */
export interface ServerExit {
  code: number | null
  signal: NodeJS.Signals | null
  /** Consecutive exits without a ready boot before this one (1-based). */
  restarts: number
}

/** Why the manager gave up booting: timeout, or too many consecutive crashes. */
export type GiveUpReason = 'timeout' | 'crashed'

/** Callbacks the shell (Electron main) subscribes to. */
export interface ServerManagerHooks {
  /** One complete stdout line from the server. */
  onLine?: (line: string) => void
  /** One complete stderr line from the server. */
  onErrorLine?: (line: string) => void
  /** The readiness URL, exactly once per successful boot. */
  onReady?: (url: string) => void
  /** A server exit while the manager is not stopping. */
  onExit?: (exit: ServerExit) => void
  /** Boot failed permanently; the shell should quit with a dialog. */
  onGiveUp?: (reason: GiveUpReason) => void
}

/** Spawn factory shape; the shell passes the real node:child_process spawn. */
export type SpawnFn = typeof spawn

/** Constructed with the full process contract; no hidden defaults. */
export interface ServerManagerOptions extends ServerManagerHooks {
  spawn: SpawnFn
  command: string
  args: string[]
  cwd: string
  /** The first capture group must be the URL. */
  readyPattern: RegExp
  bootTimeoutMs: number
  maxRestarts: number
  /** Kill one process tree; the shell supplies the platform kill. */
  killTree: (proc: ChildProcess) => void
}

export class ServerManager {
  private proc: ChildProcess | null = null
  private out = ''
  private err = ''
  private timer: NodeJS.Timeout | null = null
  private stopping = false
  private ready = false
  private restarts = 0

  constructor(private readonly options: ServerManagerOptions) {}

  /** Spawn the server unless stopping or already running. */
  start(): void {
    if (this.stopping || this.proc !== null) return
    const proc = this.options.spawn(this.options.command, this.options.args, {
      cwd: this.options.cwd,
      stdio: ['ignore', 'pipe', 'pipe'] as const,
      windowsHide: true,
    })
    this.proc = proc
    this.out = ''
    this.err = ''
    this.ready = false
    proc.stdout.on('data', (chunk: Buffer) => { this.consumeStdout(chunk) })
    proc.stderr.on('data', (chunk: Buffer) => { this.consumeStderr(chunk) })
    this.timer = setTimeout(() => {
      this.timer = null
      if (this.stopping) return
      this.stop()
      this.options.onGiveUp?.('timeout')
    }, this.options.bootTimeoutMs)
    proc.on('error', (error: Error) => {
      this.options.onErrorLine?.(`spawn failed: ${error.message}`)
      this.stop()
      this.options.onGiveUp?.('crashed')
    })
    proc.on('exit', (code, signal) => { this.handleExit(proc, code, signal) })
  }

  /** Stop the server and any pending boot; idempotent, fires no callbacks. */
  stop(): void {
    this.stopping = true
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (this.proc !== null && this.proc.exitCode === null && this.proc.signalCode === null) {
      this.options.killTree(this.proc)
    }
    this.proc = null
  }

  /** Buffer stdout by line, forward lines, and resolve the readiness URL once. */
  private consumeStdout(chunk: Buffer): void {
    this.out += chunk.toString('utf8')
    let newline: number
    while ((newline = this.out.indexOf('\n')) !== -1) {
      const line = this.out.slice(0, newline).trimEnd()
      this.out = this.out.slice(newline + 1)
      if (line === '') continue
      this.options.onLine?.(line)
      if (this.ready) continue
      const match = this.options.readyPattern.exec(line)
      if (match === null) continue
      this.ready = true
      this.restarts = 0
      if (this.timer !== null) {
        clearTimeout(this.timer)
        this.timer = null
      }
      this.options.onReady?.(match[1] ?? '')
    }
  }

  /** Buffer stderr by line and forward each complete line. */
  private consumeStderr(chunk: Buffer): void {
    this.err += chunk.toString('utf8')
    let newline: number
    while ((newline = this.err.indexOf('\n')) !== -1) {
      const line = this.err.slice(0, newline).trimEnd()
      this.err = this.err.slice(newline + 1)
      if (line !== '') this.options.onErrorLine?.(line)
    }
  }

  private handleExit(proc: ChildProcess, code: number | null, signal: NodeJS.Signals | null): void {
    if (this.proc !== proc) return
    this.proc = null
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (this.stopping) return
    this.restarts += 1
    this.options.onExit?.({ code, signal, restarts: this.restarts })
    if (this.restarts > this.options.maxRestarts) {
      this.stopping = true
      this.options.onGiveUp?.('crashed')
      return
    }
    this.start()
  }
}
