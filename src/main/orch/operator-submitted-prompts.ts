/**
 * F-1418: prova do `operatorChoice` pelo prompt que a PRÓPRIA CLI registrou.
 *
 * O tap do PTY (operator-cli-mentions) só enxerga o que o operador digita. No
 * Claude Code, uma sugestão de prompt aceita (Tab/Enter sobre o texto
 * sugerido) e a mensagem absorvida no meio do turno chegam ao modelo com o
 * texto inteiro, mas pelo PTY passa só a tecla — campo 12/10: "solta mais
 * panes usa devin e muse tbm" (`inputSource: suggestion_accepted`,
 * `absorbed_mid_turn`) e o pin no Devin foi redistribuído para o Kimi.
 *
 * Aqui o Nexus lê o final do transcript exato da sessão Claude que chamou o
 * spawn, pega só os `queued_command` com `origin.kind === 'human'` e exige,
 * além disso, um Enter NU humano no tap casado 1:1 com o carimbo de cada um
 * (`operatorSubmittedPromptNamesCli`). Texto lido do transcript nunca é
 * logado nem guardado — vira só um sim/não.
 */
import fsp from 'node:fs/promises';
import os from 'node:os';
import { getProviderPaneSession } from '../persistence/provider-session-store';
import { getAgentSessionInfo } from '../pty/pty-manager';
import {
  operatorSubmittedPromptNamesCli,
  type SubmittedOperatorPrompt,
} from './operator-cli-mentions';
import { resolveExactClaudeTranscriptPath } from './pane-activity-summary';

/** Teto da leitura do final do transcript (30 min de conversa cabem com folga). */
export const SUBMITTED_PROMPT_TAIL_BYTES = 4 * 1024 * 1024;
/** Linha maior que isto é saída de ferramenta, nunca um prompt humano. */
const MAX_LINE_CHARS = 64 * 1024;
const MAX_PROMPT_CHARS = 8 * 1024;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function isHumanOrigin(value: unknown): boolean {
  return record(value)?.kind === 'human';
}

function timestampOf(...values: unknown[]): number {
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const at = Date.parse(value);
    if (Number.isFinite(at)) return at;
  }
  return Number.NaN;
}

/**
 * Pura: prompts humanos de um trecho de transcript do Claude Code (JSONL).
 * Só a mensagem que a TUI enfileirou pelo operador
 * (`attachment.type === 'queued_command'` com `origin.kind === 'human'`):
 * sugestão aceita e mensagem absorvida no meio do turno. A mensagem `user`
 * comum fica de fora (revisão Fable): é por ela que entra texto que o
 * próprio Nexus cola no composer (handoff, retomada) — e o prompt digitado
 * já é julgado pelo tap.
 */
export function extractClaudeHumanPrompts(
  jsonl: string,
  sinceMs = Number.NEGATIVE_INFINITY,
): SubmittedOperatorPrompt[] {
  const prompts: SubmittedOperatorPrompt[] = [];
  for (const line of jsonl.split('\n')) {
    if (line.length === 0 || line.length > MAX_LINE_CHARS) continue;
    if (!line.includes('"queued_command"')) continue;
    let entry: Record<string, unknown> | null;
    try {
      entry = record(JSON.parse(line));
    } catch {
      continue;
    }
    const attachment = record(entry?.attachment);
    if (
      entry?.type !== 'attachment' ||
      attachment?.type !== 'queued_command' ||
      !isHumanOrigin(attachment.origin) ||
      typeof attachment.prompt !== 'string' ||
      attachment.prompt.length === 0
    ) {
      continue;
    }
    const at = timestampOf(attachment.timestamp, entry.timestamp);
    if (!Number.isFinite(at) || at < sinceMs) continue;
    prompts.push({ at, text: attachment.prompt.slice(0, MAX_PROMPT_CHARS) });
  }
  return prompts;
}

async function readTail(file: string, maxBytes: number): Promise<string> {
  const handle = await fsp.open(file, 'r');
  try {
    const { size } = await handle.stat();
    if (size <= 0) return '';
    const length = Math.min(size, maxBytes);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    const text = buffer.toString('utf-8');
    // Começo cortado no meio de uma linha: descarta o fragmento.
    return length < size ? text.slice(text.indexOf('\n') + 1) : text;
  } finally {
    await handle.close();
  }
}

export interface SubmittedPromptDeps {
  /** Transcript exato da sessão que chamou o spawn (null = sem prova). */
  readonly transcriptFor?: (sessionId: string) => string | null;
  readonly readTail?: (file: string, maxBytes: number) => Promise<string>;
}

/** Só sessões Claude Code: o formato do transcript é o dele. */
function defaultTranscriptFor(sessionId: string): string | null {
  const info = getAgentSessionInfo(sessionId);
  if (!info?.paneId || info.adapterId !== 'claude') return null;
  const provider = getProviderPaneSession(info.scope, info.paneId, info.adapterId, info.accountId);
  return resolveExactClaudeTranscriptPath({
    home: os.homedir(),
    adapterId: info.adapterId,
    cwd: info.cwd,
    sessionId: provider?.id,
    transcriptPath: provider?.transcriptPath,
  });
}

/**
 * F-1418: o operador nomeou esta CLI num prompt que a TUI registrou como
 * dele (sugestão aceita, mensagem no meio do turno) dentro da janela? Falha
 * fechada: qualquer erro de leitura vira `false` (o pin volta a preferência).
 */
export async function operatorNamedCliInSubmittedPrompts(
  sessionId: string | undefined,
  adapterId: string,
  now: number,
  windowMs: number,
  deps: SubmittedPromptDeps = {},
): Promise<boolean> {
  if (!sessionId) return false;
  try {
    const file = (deps.transcriptFor ?? defaultTranscriptFor)(sessionId);
    if (!file) return false;
    const tail = await (deps.readTail ?? readTail)(file, SUBMITTED_PROMPT_TAIL_BYTES);
    const prompts = extractClaudeHumanPrompts(tail, now - windowMs);
    return operatorSubmittedPromptNamesCli(sessionId, adapterId, prompts, now, windowMs);
  } catch {
    return false;
  }
}
