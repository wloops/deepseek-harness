/**
 * Process-level tests for the desktop shell's server lifecycle: real spawned
 * node children stand in for the dsh web server (printing the readiness line,
 * crashing, or hanging), so the suite exercises the actual process plumbing
 * without an Electron GUI or a full dsh boot.
 */

import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ServerManager, type ServerExit, type ServerManagerOptions } from '../src/server-manager.ts'

const instances: ServerManager[] = []

afterEach(() => {
  for (const manager of instances) manager.stop()
  instances.length = 0
})

/** Build a manager whose spawn factory runs one inline node script per attempt. */
function manager(
  scripts: string | ((attempt: number) => string),
  overrides: Partial<ServerManagerOptions> = {},
): ServerManager {
  let attempt = 0
  const options: ServerManagerOptions = {
    spawn: ((_command: string, _args: readonly string[], options: SpawnOptions) => {
      attempt += 1
      const script = typeof scripts === 'function' ? scripts(attempt) : scripts
      return spawn(process.execPath, ['-e', script], options)
    }) as unknown as typeof spawn,
    command: process.execPath,
    args: [],
    cwd: process.cwd(),
    readyPattern: /dsh web: (http:\/\/\S+)/u,
    bootTimeoutMs: 1_000,
    maxRestarts: 3,
    killTree: (proc) => { proc.kill() },
    ...overrides,
  }
  const manager = new ServerManager(options)
  instances.push(manager)
  return manager
}

describe('ServerManager', () => {
  it('resolves the readiness URL from a complete line', async () => {
    const onReady = vi.fn()
    const server = manager('console.log("dsh web: http://127.0.0.1:54321")', { onReady })
    server.start()
    await vi.waitFor(() => { expect(onReady).toHaveBeenCalledWith('http://127.0.0.1:54321') })
  })

  it('resolves the readiness URL from a line split across chunks', async () => {
    const onReady = vi.fn()
    const server = manager(
      'process.stdout.write("dsh w"); setTimeout(() => process.stdout.write("eb: http://127.0.0.1:54322\\n"), 50)',
      { onReady },
    )
    server.start()
    await vi.waitFor(() => { expect(onReady).toHaveBeenCalledWith('http://127.0.0.1:54322') })
  })

  it('fires onReady exactly once even when later lines match again', async () => {
    const onReady = vi.fn()
    const server = manager(
      'console.log("dsh web: http://127.0.0.1:1"); setTimeout(() => console.log("dsh web: http://127.0.0.1:2"), 50)',
      { onReady },
    )
    server.start()
    await vi.waitFor(() => { expect(onReady).toHaveBeenCalledTimes(1) })
    expect(onReady).toHaveBeenCalledWith('http://127.0.0.1:1')
  })

  it('forwards stdout and stderr lines', async () => {
    const onLine = vi.fn()
    const onErrorLine = vi.fn()
    const server = manager('console.log("hello"); console.error("oops"); console.log("dsh web: http://127.0.0.1:1")', {
      onLine,
      onErrorLine,
    })
    server.start()
    await vi.waitFor(() => { expect(onLine).toHaveBeenCalledWith('hello') })
    await vi.waitFor(() => { expect(onLine).toHaveBeenCalledWith('dsh web: http://127.0.0.1:1') })
    await vi.waitFor(() => { expect(onErrorLine).toHaveBeenCalledWith('oops') })
  })

  it('gives up on boot timeout and kills the hung process', async () => {
    const onGiveUp = vi.fn()
    const onExit = vi.fn()
    const server = manager('setTimeout(() => {}, 60000)', { onGiveUp, onExit, bootTimeoutMs: 200 })
    server.start()
    await vi.waitFor(() => { expect(onGiveUp).toHaveBeenCalledWith('timeout') })
    expect(onExit).not.toHaveBeenCalled()
  })

  it('restarts after a crash and resolves readiness on the next boot', async () => {
    const onReady = vi.fn()
    const onExit = vi.fn<(exit: ServerExit) => void>()
    const server = manager((attempt) => {
      // Attempt 2 stays alive after printing readiness: an immediate exit would
      // legitimately count as a post-ready crash and fire a second onExit.
      return attempt === 1 ? 'process.exit(1)' : 'console.log("dsh web: http://127.0.0.1:99"); setTimeout(() => {}, 60000)'
    }, {
      onReady,
      onExit,
    })
    server.start()
    await vi.waitFor(() => { expect(onReady).toHaveBeenCalledWith('http://127.0.0.1:99') }, { timeout: 5_000 })
    expect(onExit).toHaveBeenCalledTimes(1)
    expect(onExit.mock.calls[0]?.[0]?.restarts).toBe(1)
  })

  it('gives up after max consecutive crashes', async () => {
    const onGiveUp = vi.fn()
    const onExit = vi.fn<(exit: ServerExit) => void>()
    // maxRestarts is the restart budget: restarts 1..2 reboot, the third exit
    // exceeds it and gives up.
    const server = manager('process.exit(1)', { onGiveUp, onExit, maxRestarts: 2 })
    server.start()
    await vi.waitFor(() => { expect(onGiveUp).toHaveBeenCalledWith('crashed') }, { timeout: 5_000 })
    expect(onExit).toHaveBeenCalledTimes(3)
    expect(onExit.mock.calls[2]?.[0]?.restarts).toBe(3)
  })

  it('resets the crash budget after a successful boot', async () => {
    const onGiveUp = vi.fn()
    const onExit = vi.fn()
    // Attempt 1 crashes (budget 1), attempt 2 boots and then crashes (reset to
    // 0 on readiness), attempts 3-5 crash: 5 exits, give-up only at restarts 4.
    const server = manager((attempt) => {
      if (attempt === 1) return 'process.exit(1)'
      if (attempt === 2) return 'console.log("dsh web: http://127.0.0.1:1"); process.exit(1)'
      return 'process.exit(1)'
    }, { onGiveUp, onExit, maxRestarts: 3 })
    server.start()
    await vi.waitFor(() => { expect(onGiveUp).toHaveBeenCalledWith('crashed') }, { timeout: 10_000 })
    expect(onExit).toHaveBeenCalledTimes(5)
  })

  it('stop kills the running process, is idempotent, and prevents restarts', async () => {
    const killTree = vi.fn((proc: ChildProcess) => { proc.kill() })
    const onExit = vi.fn()
    const onGiveUp = vi.fn()
    const server = manager('setTimeout(() => {}, 60000)', { killTree, onExit, onGiveUp })
    server.start()
    await new Promise((resolvePromise) => { setTimeout(resolvePromise, 150) })
    server.stop()
    server.stop()
    expect(killTree).toHaveBeenCalledTimes(1)
    await new Promise((resolvePromise) => { setTimeout(resolvePromise, 200) })
    expect(onExit).not.toHaveBeenCalled()
    expect(onGiveUp).not.toHaveBeenCalled()
  })

  it('stop before start is a no-op', () => {
    const server = manager('process.exit(0)')
    expect(() => {
      server.stop()
      server.stop()
    }).not.toThrow()
  })

  it('reports a spawn failure and gives up', async () => {
    const onGiveUp = vi.fn()
    const onErrorLine = vi.fn()
    const server = manager('', {
      spawn: (() => { return spawn('dsh-desktop-no-such-command', []) }) as unknown as typeof spawn,
      onGiveUp,
      onErrorLine,
    })
    server.start()
    await vi.waitFor(() => { expect(onGiveUp).toHaveBeenCalledWith('crashed') })
    expect(onErrorLine).toHaveBeenCalled()
  })
})
