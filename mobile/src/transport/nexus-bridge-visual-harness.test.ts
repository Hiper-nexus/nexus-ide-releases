import { afterEach, describe, expect, it } from 'vitest'
import { nexusVisualHarnessAllowsHost as nativeAllows } from './nexus-bridge-visual-harness'
import { nexusVisualHarnessAllowsHost as webAllows } from './nexus-bridge-visual-harness.web'

// F-1035: a exceção de host IP do harness visual web nunca vale no app nativo,
// e no web só com a flag de build e só para 127.0.0.1.
describe('nexusVisualHarnessAllowsHost', () => {
  const previous = process.env.EXPO_PUBLIC_NEXUS_VISUAL_HARNESS
  afterEach(() => {
    if (previous === undefined) delete process.env.EXPO_PUBLIC_NEXUS_VISUAL_HARNESS
    else process.env.EXPO_PUBLIC_NEXUS_VISUAL_HARNESS = previous
  })

  it('never allows anything on the native/default module, flag or not', () => {
    process.env.EXPO_PUBLIC_NEXUS_VISUAL_HARNESS = '1'
    expect(nativeAllows('127.0.0.1')).toBe(false)
  })

  it('web: only with the build flag and only for 127.0.0.1', () => {
    delete process.env.EXPO_PUBLIC_NEXUS_VISUAL_HARNESS
    expect(webAllows('127.0.0.1')).toBe(false)
    process.env.EXPO_PUBLIC_NEXUS_VISUAL_HARNESS = '1'
    expect(webAllows('127.0.0.1')).toBe(true)
    for (const host of ['localhost', '192.168.0.10', '100.101.102.103', '[::1]']) {
      expect(webAllows(host)).toBe(false)
    }
  })
})
