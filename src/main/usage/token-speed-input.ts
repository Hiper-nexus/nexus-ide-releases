import { stripAnsiEscapeSequences } from '../../shared/ansi-escape-sequences'
const PROMPT_DRAFT_LIMIT = 4_000
/** Ctrl+C e Ctrl+Z. */
const CANCEL_KEY_PATTERN = /[\u0003\u001a]/
/** Bytes de controle sem semântica de edição nem quebra de linha. */
const NON_EDITING_CONTROL_PATTERN =
  /[\u0000-\u0007\u0009\u000b\u000c\u000e-\u0014\u0016\u0018-\u001f]/g
const BACKSPACE_KEYS = new Set(['\b', '\u007f'])
const CTRL_U = '\u0015'
const CTRL_W = '\u0017'

export function splitSubmittedInput(
  draft: string,
  data: string,
): { submitted: string | null; draft: string } {
  // Ctrl+C / Ctrl+Z abortam a composição: o rascunho morre e nada é submetido.
  if (CANCEL_KEY_PATTERN.test(data)) return { submitted: null, draft: '' }
  const clean = stripAnsiEscapeSequences(data)
    .replace(NON_EDITING_CONTROL_PATTERN, '')
    .replace(/\r\n?/g, '\n')
  const marker = clean.lastIndexOf('\n')
  if (marker < 0) {
    return {
      submitted: null,
      draft: applyDraftEditing(draft + clean),
    }
  }
  const submitted = applyDraftEditing(draft + clean.slice(0, marker))
  return {
    submitted,
    draft: applyDraftEditing(clean.slice(marker + 1)),
  }
}

function applyDraftEditing(value: string): string {
  const chars: string[] = []
  for (const char of value) {
    if (BACKSPACE_KEYS.has(char)) {
      chars.pop()
      continue
    }
    if (char === CTRL_U) {
      const lineStart = chars.lastIndexOf('\n') + 1
      chars.splice(lineStart)
      continue
    }
    if (char === CTRL_W) {
      const lineStart = chars.lastIndexOf('\n') + 1
      while (chars.length > lineStart && /\s/u.test(chars.at(-1)!)) chars.pop()
      while (chars.length > lineStart && !/\s/u.test(chars.at(-1)!)) chars.pop()
      continue
    }
    chars.push(char)
  }
  return chars.join('').slice(-PROMPT_DRAFT_LIMIT)
}

export function hasSubmittedPrompt(submitted: string): boolean {
  return submitted.trim().length > 0
}

