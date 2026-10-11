import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { MacosSystemSleepAssertion } from './macos-system-sleep-assertion'

describe('MacosSystemSleepAssertion', () => {
  it('F-1186: caffeinate watches this process, so it never outlives Nexus', () => {
    const child = Object.assign(new EventEmitter(), { kill: vi.fn(() => true), pid: 4242 })
    const spawn = vi.fn(() => child)
    const assertion = new MacosSystemSleepAssertion({ platform: 'darwin', spawn })

    expect(assertion.start('agent-working')).toBe(true)

    expect(spawn).toHaveBeenCalledWith(
      '/usr/bin/caffeinate',
      ['-i', '-s', '-w', String(process.pid)],
      expect.objectContaining({ stdio: 'ignore' })
    )
    assertion.dispose()
    expect(child.kill).toHaveBeenCalled()
  })
})
