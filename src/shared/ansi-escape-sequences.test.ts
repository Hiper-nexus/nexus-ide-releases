import { describe, expect, it } from 'vitest'
import {
  CSI_SEQUENCE_PATTERN,
  ESCAPE_SEQUENCE_PATTERN,
  OSC_SEQUENCE_PATTERN,
  STRING_SEQUENCE_PATTERN,
  removeTerminatedSequences,
  stripAnsiEscapeSequences,
} from './ansi-escape-sequences'
import { cpuTimeMs } from '../test/cpu-time'

/** A implementação anterior, só com regex — a referência semântica. */
function referenceStrip(value: string): string {
  return value
    .replace(OSC_SEQUENCE_PATTERN, '')
    .replace(STRING_SEQUENCE_PATTERN, '')
    .replace(CSI_SEQUENCE_PATTERN, '')
    .replace(ESCAPE_SEQUENCE_PATTERN, '')
}

/** Gerador determinístico (mulberry32): a falha é reproduzível pela semente. */
function rng(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const ALPHABET = [
  '\u001b', ']', '[', '\\', '\u0007', '\u009c', '\u009d', '\u0090', '\u0098',
  '\u009e', '\u009f', '\u009b', 'P', '_', '^', 'X', '0', ';', 'm', 'a', ' ', '\n',
  // F-1406: parâmetros privados de CSI (ESC[>4;0m, ESC[<0;1m, ESC[=1u).
  '>', '=', '<',
]

function randomText(next: () => number, maxLength: number): string {
  const length = Math.floor(next() * maxLength)
  let out = ''
  for (let i = 0; i < length; i += 1) {
    out += ALPHABET[Math.floor(next() * ALPHABET.length)]
  }
  return out
}

describe('stripAnsiEscapeSequences (F-764 C.3)', () => {
  it('remove o mesmo que a versão por regex em 20 mil textos aleatórios', () => {
    const next = rng(764)
    for (let i = 0; i < 20_000; i += 1) {
      const text = randomText(next, 48)
      expect(stripAnsiEscapeSequences(text), JSON.stringify(text)).toBe(referenceStrip(text))
    }
  })

  it.each([
    ['título OSC com BEL', 'a\u001b]0;título\u0007b', 'ab'],
    ['título OSC com ST', 'a\u001b]2;t\u001b\\b', 'ab'],
    ['OSC de 8 bits', 'a\u009d0;t\u009cb', 'ab'],
    ['DCS com ST', 'a\u001bPq#0\u001b\\b', 'ab'],
    ['OSC sem terminador fica como texto', 'a\u001b]0;t', 'a0;t'],
    ['primeiro terminador encerra', '\u001b]x\u0007y\u0007', 'y\u0007'],
    ['cores e cursor', '\u001b[1;31mok\u001b[0m\u001b[2K', 'ok'],
  ])('%s', (_label, input, expected) => {
    expect(stripAnsiEscapeSequences(input)).toBe(expected)
    expect(referenceStrip(input)).toBe(expected)
  })

  it('removeTerminatedSequences devolve a mesma string quando nada casa', () => {
    const value = 'sem escape algum'
    expect(removeTerminatedSequences(value, /\u001b\]/g, /\u0007/g)).toBe(value)
  })

  it.each([
    ['ESC ] sem terminador', '\u001b]'.repeat(8_192)],
    ['DCS sem ST', '\u001bP'.repeat(8_192)],
    ['C1 de 8 bits sem ST', '\u0090\u009d'.repeat(8_192)],
  ])('%s: 16 KB em tempo linear', (_label, text) => {
    // A versão por regex passava de 60 ms aqui; a linear fica abaixo de 1 ms.
    expect(cpuTimeMs(() => stripAnsiEscapeSequences(text))).toBeLessThan(20)
  })
})
