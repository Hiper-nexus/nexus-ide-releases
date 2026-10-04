/**
 * F-788/F-789: cauda sanitizada da saída de um pane que morreu antes do
 * primeiro turno. Usada no trace local (`pane-not-started`) e no artifact
 * untrusted de recuperação de handoff, sem promover a cauda a relatório completo.
 *
 * Tudo aqui é linear no tamanho da entrada (lição do F-764, regex quadrática
 * no Main): a varredura olha só o fim do ring, cada linha passa uma vez por
 * padrões sem quantificadores sobrepostos, e os redatores compartilhados —
 * que têm cantos quadráticos em texto livre (`[\r\n]` seguido de `\s*`,
 * esquema de URL sem teto) — só recebem as últimas linhas, já cortadas.
 */
import {
  CSI_SEQUENCE_PATTERN,
  ESCAPE_SEQUENCE_PATTERN,
  TERMINAL_CONTROL_CHARACTER_PATTERN,
} from '../../shared/ansi-escape-sequences';
import { redactVisibleSecrets } from '../../shared/vision-ipc';
import { redactCommandLine } from '../terminal/command-redaction';
import { sanitizeMissionOrchestratorExitOutput } from './mission-orchestrator-exit-policy';

export const PANE_BOOT_OUTPUT_MAX_LINES = 40;
export const PANE_BOOT_OUTPUT_MAX_CHARS = 8_192;
/** Só o fim do ring é varrido: o diagnóstico é a cauda. */
export const PANE_BOOT_OUTPUT_SCAN_CHARS = 16_384;
/** Teto por linha antes dos redatores compartilhados. */
const MAX_LINE_CHARS = 512;

/* eslint-disable no-control-regex -- removem bytes de controle do terminal. */
/**
 * OSC/DCS/APC/PM/SOS numa passada: o conteúdo para no primeiro BEL/ESC/ST e o
 * terminador é opcional. O padrão compartilhado (`[\s\S]*?` até o terminador)
 * reescaneia o resto do texto a cada introdutor sem fim.
 */
const STRING_SEQUENCE =
  /(?:\u001b[\]P^_X]|[\u0090\u0098\u009d-\u009f])[^\u0007\u001b\u009c]*(?:\u0007|\u001b\\|\u009c)?/gu;
/* eslint-enable no-control-regex */
const LINE_BREAK = /\r\n|\r|\n/u;
const HORIZONTAL_SPACE = /[ \t ]+/gu;
/** Spinner Braille de TUI: quadros seguidos da mesma linha viram um só. */
const SPINNER_GLYPHS = /[⠀-⣿]/gu;
/** Linha que é só um bloco base64/hex longo: corpo de chave ou token solto. */
const ENCODED_BLOB_LINE = /^[A-Za-z0-9+/]{40,}={0,2}$/u;
const FINGERPRINT = /fingerprint/iu;

const OMITTED = '[...saída anterior omitida...]';
const KEY_REDACTED = '[chave privada redigida]';
const BLOB_REDACTED = '[bloco codificado redigido]';
const FINGERPRINT_REDACTED = '[identidade opaca redigida]';

function plainLine(line: string): string {
  return line
    .replace(STRING_SEQUENCE, '')
    .replace(CSI_SEQUENCE_PATTERN, '')
    .replace(ESCAPE_SEQUENCE_PATTERN, '')
    .replace(TERMINAL_CONTROL_CHARACTER_PATTERN, '')
    .replace(HORIZONTAL_SPACE, ' ')
    .trim();
}

function isPrivateKeyMarker(line: string, marker: '-----BEGIN' | '-----END'): boolean {
  return line.includes(marker) && line.includes('PRIVATE KEY');
}

function redactLine(line: string): string {
  return redactCommandLine(redactVisibleSecrets(line), { denylist: [] }).command;
}

/** Diagnóstico local: até 40 linhas e 8 KB, sem segredo, sem controle de terminal. */
export function sanitizePaneBootOutput(raw: string): string {
  const windowCut = raw.length > PANE_BOOT_OUTPUT_SCAN_CHARS;
  const lines = (windowCut ? raw.slice(-PANE_BOOT_OUTPUT_SCAN_CHARS) : raw).split(LINE_BREAK);
  // A primeira linha de uma janela cortada é um pedaço: pode ser meio token.
  if (windowCut) lines.shift();
  const kept: string[] = [];
  let lastKey: string | null = null;
  let omitted = windowCut;
  let insideKey = false;
  const push = (line: string): void => {
    const key = line.replace(SPINNER_GLYPHS, '').trim();
    if (key === lastKey) {
      kept[kept.length - 1] = line;
      return;
    }
    kept.push(line);
    lastKey = key;
  };
  for (const rawLine of lines) {
    const line = plainLine(rawLine);
    if (!line) continue;
    if (insideKey) {
      if (isPrivateKeyMarker(line, '-----END')) insideKey = false;
      continue;
    }
    if (isPrivateKeyMarker(line, '-----BEGIN')) {
      push(KEY_REDACTED);
      insideKey = !isPrivateKeyMarker(line, '-----END');
      continue;
    }
    if (isPrivateKeyMarker(line, '-----END')) {
      // A janela começou no meio de uma chave: o que veio antes é o corpo dela.
      kept.length = 0;
      lastKey = null;
      omitted = true;
      push(KEY_REDACTED);
      continue;
    }
    if (ENCODED_BLOB_LINE.test(line)) {
      push(BLOB_REDACTED);
      continue;
    }
    if (FINGERPRINT.test(line)) {
      push(FINGERPRINT_REDACTED);
      continue;
    }
    push(line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}…` : line);
  }
  const tail = kept.slice(-PANE_BOOT_OUTPUT_MAX_LINES).map(redactLine);
  if (kept.length > tail.length) omitted = true;
  return sanitizeMissionOrchestratorExitOutput(
    (omitted && tail.length > 0 ? [OMITTED, ...tail] : tail).join('\n'),
    {
      maxLines: PANE_BOOT_OUTPUT_MAX_LINES + 1,
      maxChars: PANE_BOOT_OUTPUT_MAX_CHARS,
    },
  );
}
