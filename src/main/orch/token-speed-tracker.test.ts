import { describe, expect, it } from 'vitest'
import {
  hasSubmittedPrompt,
  splitSubmittedInput,
  tokenSpeedUsageEventAt,
} from './token-speed-tracker'

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

  it('Backspace corrige o rascunho usado para reconhecer o eco', () => {
    expect(splitSubmittedInput('olx', '\u007fá\r')).toEqual({
      submitted: 'olá',
      draft: '',
    })
    expect(splitSubmittedInput('olx', '\bá\r')).toEqual({
      submitted: 'olá',
      draft: '',
    })
  })

  it('Ctrl+U limpa a linha e Ctrl+W apaga a última palavra', () => {
    expect(splitSubmittedInput('texto errado', '\u0015correto\r')).toEqual({
      submitted: 'correto',
      draft: '',
    })
    expect(splitSubmittedInput('gere um relatorio', '\u0017resumo\r')).toEqual({
      submitted: 'gere um resumo',
      draft: '',
    })
  })

  it('CRLF vale como um único submit e não contamina o prompt com CR', () => {
    expect(splitSubmittedInput('', 'linha um\r\n')).toEqual({
      submitted: 'linha um',
      draft: '',
    })
  })
})

describe('hasSubmittedPrompt', () => {
  it('recusa Enter vazio ou só com espaços', () => {
    expect(hasSubmittedPrompt('')).toBe(false)
    expect(hasSubmittedPrompt(' \n\t ')).toBe(false)
  })

  it('aceita conteúdo real, inclusive prompt multilinha', () => {
    expect(hasSubmittedPrompt('explique isto')).toBe(true)
    expect(hasSubmittedPrompt('linha um\nlinha dois')).toBe(true)
  })
})

describe('tokenSpeedUsageEventAt', () => {
  it('prefere o timestamp do transcript para casar a rodada correta', () => {
    expect(
      tokenSpeedUsageEventAt(
        { key: 's:1', outputTokens: 10, timestamp: 1_234 },
        9_999,
      ),
    ).toBe(1_234)
  })

  it('cai no instante observado quando o transcript não tem timestamp válido', () => {
    expect(
      tokenSpeedUsageEventAt({ key: 's:1', outputTokens: 10 }, 9_999),
    ).toBe(9_999)
    expect(
      tokenSpeedUsageEventAt(
        { key: 's:1', outputTokens: 10, timestamp: Number.NaN },
        9_999,
      ),
    ).toBe(9_999)
  })
})
