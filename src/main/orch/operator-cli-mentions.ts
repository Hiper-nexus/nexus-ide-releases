/**
 * Uso geral: quando o operador DIGITA o nome de uma CLI no próprio pane que
 * chama nexus_pane_spawn, um adapterId explícito é escolha dele — não um pin
 * genérico do agente. Este módulo observa apenas o input humano do PTY
 * (`origin === 'human'`) em memória volátil e responde "o operador nomeou
 * esta CLI nos últimos 15 min?".
 *
 * Contrato do SessionInputTap: o texto é observacional — NUNCA persistido,
 * logado nem encaminhado. Só timestamps + trechos sanitizados em RAM, com
 * retenção de 30 minutos e teto de 4.000 caracteres por sessão.
 */
import { tapSessionExit, tapSessionInput } from '../pty/pty-manager';

const MENTION_WINDOW_MS = 15 * 60_000;
const RETENTION_MS = 30 * 60_000;
const MAX_RETAINED_CHARS = 4_000;

interface InputChunk {
  readonly at: number;
  readonly text: string;
}

const inputBySession = new Map<string, InputChunk[]>();
let installed = false;

/** Aliases conhecidos → adapter. Adapter fora da lista casa pelo próprio id. */
const CLI_MENTION_ALIASES: Readonly<Record<string, readonly string[]>> = {
  claude: ['claude', 'opus', 'sonnet', 'haiku', 'fable', 'mythos'],
  codex: ['codex', 'gpt', 'astra', 'openai'],
  grok: ['grok', 'xai'],
  agy: ['agy', 'gemini', 'antigravity'],
  kimi: ['kimi', 'moonshot'],
  glm: ['glm', 'zai'],
  'glm-flash': ['glm', 'zai'],
  'mimo-code': ['mimo', 'xiaomi'],
  'minimax-code': ['minimax'],
  devin: ['devin', 'swe'],
  longcat: ['longcat'],
  muse: ['muse'],
  'muse-claude': ['muse'],
  deepseek: ['deepseek'],
  opencode: ['opencode'],
  openclaude: ['openclaude'],
  aider: ['aider'],
  qwen: ['qwen', 'qwen code', 'qwen 3.8'],
};

/* eslint-disable no-control-regex */
const OSC_PATTERN = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const CSI_PATTERN = /\x1b\[[0-9;?]*[ -\/]*[@-~]/g;
const ESC_PATTERN = /\x1b[@-_]/g;
const CONTROL_PATTERN = /[\x00-\x09\x0b\x0c\x0e-\x1f\x7f]/g;
/* eslint-enable no-control-regex */

/**
 * Tira ANSI/OSC/CSI/paste e controles por inteiro — um escape no meio de uma
 * palavra não vira fronteira (o terminal também renderia contíguo). Newline
 * vira espaço de fronteira.
 */
function sanitizeInput(data: string): string {
  return data
    .replace(OSC_PATTERN, '')
    .replace(CSI_PATTERN, '')
    .replace(ESC_PATTERN, '')
    .replace(/[\r\n]+/g, ' ')
    .replace(CONTROL_PATTERN, '');
}

function normalizeForMatch(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
}

function aliasesFor(adapterId: string): readonly string[] {
  return CLI_MENTION_ALIASES[adapterId] ?? [adapterId];
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function remember(sessionId: string, data: string): void {
  const text = sanitizeInput(data);
  // Mantém espaços: são fronteira de palavra. `!text.trim()` descartava a
  // tecla espaço digitada sozinha e "solta grok" virava "soltagrok" — o
  // `\bgrok\b` nunca casava (campo 05/10). Só chunks realmente vazios caem.
  if (!text) return;
  const now = Date.now();
  const chunks = [...(inputBySession.get(sessionId) ?? []), { at: now, text }]
    .filter((chunk) => now - chunk.at <= RETENTION_MS);
  // Teto por sessão: corta do lado antigo até caber em MAX_RETAINED_CHARS.
  let total = chunks.reduce((sum, chunk) => sum + chunk.text.length, 0);
  while (total > MAX_RETAINED_CHARS && chunks.length > 0) {
    total -= chunks[0]!.text.length;
    chunks.shift();
  }
  if (chunks.length > 0) {
    inputBySession.set(sessionId, chunks);
  } else {
    inputBySession.delete(sessionId);
  }
}

/**
 * F-682: janela da PROVA exigida por `operatorChoice:true` — a retenção inteira
 * do input do operador (a flag sozinha é afirmação do agente, não pedido).
 */
export const OPERATOR_CHOICE_PROOF_WINDOW_MS = RETENTION_MS;

/**
 * F-682: orientação que o operador enviou pelo Quadro à sessão (entregue e
 * aceita) conta como input dele — mesmo contrato de memória volátil.
 */
export function noteOperatorDirection(sessionId: string, text: string): void {
  remember(sessionId, text);
}

/**
 * Instala os taps uma vez (bootstrap do Main). Devolve o disposer — usado
 * pelos testes; em produção a instalação vive com o processo.
 */
export function installOperatorCliMentionTap(): () => void {
  if (installed) return () => {};
  installed = true;
  const untapInput = tapSessionInput((sessionId, data, origin) => {
    if (origin !== 'human') return;
    remember(sessionId, data);
  });
  const untapExit = tapSessionExit((sessionId) => {
    inputBySession.delete(sessionId);
  });
  return () => {
    untapInput();
    untapExit();
    inputBySession.clear();
    installed = false;
  };
}

/**
 * O operador nomeou esta CLI nesta sessão nos últimos 15 minutos? Casa alias
 * como PALAVRA INTEIRA sobre o input humano sanitizado (caixa e acentos
 * ignorados). Sem sessão → false (o pin volta a ser preferência).
 */
export function operatorRecentlyNamedCli(
  sessionId: string | undefined,
  adapterId: string,
  now = Date.now(),
  windowMs = MENTION_WINDOW_MS,
): boolean {
  if (!sessionId) return false;
  const chunks = inputBySession.get(sessionId);
  if (!chunks || chunks.length === 0) return false;
  const window = Math.min(windowMs, RETENTION_MS);
  const recent = chunks.filter(
    (chunk) => now - chunk.at >= 0 && now - chunk.at <= window,
  );
  if (recent.length === 0) return false;
  // Concatena sem inserir espaço entre chunks: a digitação tecla a tecla chega
  // como um chunk por caractere, e `join(' ')` virava "g r o k" — o `\bgrok\b`
  // nunca casava e o operatorChoice era redistribuído ("solta grok solta agy"
  // no meio do turno, 05/10). O sanitize já converte Enter em espaço, então
  // fronteiras de mensagem continuam separadas.
  const normalized = normalizeForMatch(
    recent.map((chunk) => chunk.text).join(''),
  );
  return aliasesFor(adapterId).some((alias) => {
    const normalizedAlias = normalizeForMatch(alias);
    if (!normalizedAlias) return false;
    return new RegExp(`\\b${escapeRegex(normalizedAlias)}\\b`, 'u').test(
      normalized,
    );
  });
}
