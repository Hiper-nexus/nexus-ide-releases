import { describe, expect, it } from 'vitest'
import { splitSubmittedInput } from './token-speed-tracker'

/**
 * Detecção de submit a partir do fluxo de teclas do PTY. O restante do
 * tracker (taps, escopo, throttle) é plumbing sobre `TokenSpeedMeter`, que
 * tem sua própria bateria em `src/main/usage/token-speed-meter.test.ts`.
 */
describe('splitSubmittedInput', () => {
  it('acumula digitação sem submeter até o Enter', () => {
    let draft = ''
    for (const key of ['o', 'i', ' ', 'l', 'á']) {
      const step = splitSubmittedInput(draft, key)
      expect(step.submitted).toBeNull()
      draft = step.draft
    }
    expect(draft).toBe('oi lá')
    expect(splitSubmittedInput(draft, '\r')).toEqual({
      submitted: 'oi lá',
      draft: '',
    })
  })

  it('submete prompt colado inteiro em um único write', () => {
    expect(splitSubmittedInput('', 'refatore o tracker\r')).toEqual({
      submitted: 'refatore o tracker',
      draft: '',
    })
  })

  it('preserva o que vem depois do último Enter como novo rascunho', () => {
    expect(splitSubmittedInput('', 'linha um\nresto')).toEqual({
      submitted: 'linha um',
      draft: 'resto',
    })
  })

  it('descarta sequências ANSI de paste bracketed e setas', () => {
    const { submitted } = splitSubmittedInput(
      '',
      '\u001b[200~texto colado\u001b[201~\r',
    )
    expect(submitted).toBe('texto colado')
  })

  it('Ctrl+C e Ctrl+Z abortam o rascunho sem submeter', () => {
    expect(splitSubmittedInput('meio escrito', '\u0003')).toEqual({
      submitted: null,
      draft: '',
    })
    expect(splitSubmittedInput('meio escrito', '\u001a')).toEqual({
      submitted: null,
      draft: '',
    })
  })

  it('limita o rascunho retido em memória', () => {
    const huge = 'a'.repeat(10_000)
    const { draft } = splitSubmittedInput('', huge)
    expect(draft.length).toBeLessThanOrEqual(4_000)
  })

  it('Enter isolado submete prompt vazio sem quebrar', () => {
    expect(splitSubmittedInput('', '\r')).toEqual({ submitted: '', draft: '' })
  })
})
