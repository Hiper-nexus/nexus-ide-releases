import { spawn as nodeSpawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { LinuxLidSleepAssertion } from './linux-lid-sleep-assertion'

function startWithCapturedSpawn() {
  const child = Object.assign(new EventEmitter(), { kill: vi.fn(() => true), pid: 4242 })
  const spawn = vi.fn((_command: string, _args: string[], _options: { stdio: unknown }) => child)
  const assertion = new LinuxLidSleepAssertion({ platform: 'linux', spawn })
  assertion.start('agent-working')
  const [command, args, options] = spawn.mock.calls[0]
  return { assertion, child, command, args, options }
}

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe('LinuxLidSleepAssertion', () => {
  it('F-1212: the inhibitor wraps a command that ends on stdin EOF, never `sleep infinity`', () => {
    const { assertion, child, command, args, options } = startWithCapturedSpawn()

    expect(command).toBe('systemd-inhibit')
    expect(args).not.toContain('infinity')
    expect(args.at(-1)).toBe('cat')
    expect(options).toMatchObject({ stdio: ['pipe', 'ignore', 'ignore'] })

    assertion.dispose()
    expect(child.kill).toHaveBeenCalled()
  })

  it.skipIf(process.platform === 'win32')(
    'F-1212: the command systemd-inhibit would run dies when its owner is SIGKILLed',
    async () => {
      const { assertion, args, options } = startWithCapturedSpawn()
      assertion.dispose()
      const inner = args.slice(args.indexOf('--mode=block') + 1)
      // The owner stands in for Nexus: it runs exactly what systemd-inhibit
      // would exec (same stdio), reports the pid and then just stays alive.
      const owner = nodeSpawn(
        process.execPath,
        [
          '-e',
          `const c = require('node:child_process').spawn(${JSON.stringify(inner[0])}, ${JSON.stringify(inner.slice(1))}, ${JSON.stringify({ stdio: options.stdio })});
           process.stdout.write(String(c.pid)); setInterval(() => {}, 1000)`
        ],
        { stdio: ['ignore', 'pipe', 'ignore'] }
      )
      const innerPid = Number(
        await new Promise<string>((resolve) => owner.stdout.once('data', (d) => resolve(String(d))))
      )
      try {
        await new Promise((resolve) => setTimeout(resolve, 300))
        expect(isAlive(innerPid)).toBe(true)

        owner.kill('SIGKILL')
        for (let i = 0; i < 60 && isAlive(innerPid); i++) {
          await new Promise((resolve) => setTimeout(resolve, 50))
        }
        expect(isAlive(innerPid)).toBe(false)
      } finally {
        owner.kill('SIGKILL')
        if (isAlive(innerPid)) process.kill(innerPid, 'SIGKILL')
      }
    }
  )
})
