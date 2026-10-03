/**
 * Uso geral: quando o operador DIGITA o nome de uma CLI no próprio pane que
 * chama nexus_pane_spawn, um adapterId explícito é escolha dele — não um pin
 * genérico do agente. Este módulo observa apenas o input humano do PTY
 * (`origin === 'human'`) em memória volátil e responde "o operador nomeou
 * esta CLI nos últimos 15 min?".
 *
 * O compositor do Nexus e o teclado do pane governado já entram como `human`
 * (`orch:panes.operatorInput`). A orientação do Quadro entra por
 * `noteOperatorDirection`. Escrita `system` (kickoff, handoff, injeção) não
 * conta. O buffer por sessão concatena teclas sem separador e aplica
 * backspace; setas não movem o cursor (teto: linha linear, sem edição no meio).
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
// Backspace (\b/\x7f), tab e newline ficam: o replay apaga ou vira fronteira.
const CONTROL_PATTERN = /[\x00-\x07\x0b\x0c\x0e-\x1f]/g;
/* eslint-enable no-control-regex */

/**
 * Tira ANSI/OSC/CSI/paste e controles que não editam — um escape no meio de
 * uma palavra não vira fronteira. Backspace e newline sobrevivem para o replay.
 */
function sanitizeInput(data: string): string {
  return data
    .replace(OSC_PATTERN, '')
    .replace(CSI_PATTERN, '')
    .replace(ESC_PATTERN, '')
    .replace(CONTROL_PATTERN, '');
}

function isBackspace(ch: string): boolean {
  return ch === '\b' || ch === '\x7f';
}

function startsWithSpaceOrBackspace(text: string): boolean {
  const ch = text[0];
  return ch !== undefined && (isBackspace(ch) || /\s/u.test(ch));
}

/** Colagem (mais de um caractere visível). Tecla solta não leva separador. */
function isPasteChunk(text: string): boolean {
  let visible = 0;
  for (const ch of text) {
    if (!isBackspace(ch)) visible += 1;
    if (visible > 1) return true;
  }
  return false;
}

/**
 * Reconstrói a linha: teclas coladas, backspace apaga a anterior, newline/tab
 * viram espaço. Colagem nova ganha fronteira se o buffer não terminou nela.
 * ponytail: não rastreia cursor — seta é CSI e some; edição no meio da linha
 * não existe. Subir isso exige posição de cursor no tap.
 */
function replayInput(chunks: readonly InputChunk[]): string {
  let out = '';
  for (const chunk of chunks) {
    const text = chunk.text;
    if (
      isPasteChunk(text) &&
      out.length > 0 &&
      !/\s$/u.test(out) &&
      !startsWithSpaceOrBackspace(text)
    ) {
      out += ' ';
    }
    for (const ch of text) {
      if (isBackspace(ch)) {
        out = out.slice(0, -1);
        continue;
      }
      if (ch === '\n' || ch === '\r' || ch === '\t') {
        if (!out.endsWith(' ')) out += ' ';
        continue;
      }
      out += ch;
    }
  }
  return out;
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

/** "anti gravity" / "anti-gravity" casam "antigravity". Apelido curto fica exato. */
function flexibleAliasPattern(core: string): RegExp {
  const parts = [...core].map((ch) => escapeRegex(ch));
  return new RegExp(`(?<![a-z0-9])${parts.join('[\\s-]*')}(?![a-z0-9])`, 'u');
}

/**
 * Uma edição (troca ou letra a mais/a menos). Sem relação de prefixo: "code"
 * não vira codex e "use" não vira muse. Apelido com menos de 4 letras nem chega aqui.
 */
function withinOneEdit(a: string, b: string): boolean {
  if (a === b) return false;
  const diff = a.length - b.length;
  if (diff === 0) {
    let changes = 0;
    for (let i = 0; i < a.length; i += 1) {
      if (a[i] !== b[i]) changes += 1;
      if (changes > 1) return false;
    }
    return changes === 1;
  }
  if (diff !== 1 && diff !== -1) return false;
  const [shorter, longer] = a.length < b.length ? [a, b] : [b, a];
  let i = 0;
  let j = 0;
  let skipped = false;
  while (i < shorter.length && j < longer.length) {
    if (shorter[i] === longer[j]) {
      i += 1;
      j += 1;
    } else if (skipped) {
      return false;
    } else {
      skipped = true;
      j += 1;
    }
  }
  return true;
}

function aliasMatches(text: string, alias: string): boolean {
  const normalizedAlias = normalizeForMatch(alias);
  if (!normalizedAlias) return false;
  const core = normalizedAlias.replace(/[\s-]+/g, '');
  if (core.length < 4) {
    return new RegExp(
      `(?<![a-z0-9])${escapeRegex(normalizedAlias)}(?![a-z0-9])`,
      'u',
    ).test(text);
  }
  if (flexibleAliasPattern(core).test(text)) return true;
  if (!/^[a-z]+$/u.test(core)) return false;
  for (const word of text.split(/[^a-z0-9]+/u)) {
    if (word.length < 4 || Math.abs(word.length - core.length) > 1) continue;
    if (word.startsWith(core) || core.startsWith(word)) continue;
    if (withinOneEdit(word, core)) return true;
  }
  return false;
}

function remember(sessionId: string, data: string): void {
  const text = sanitizeInput(data);
  // Espaço e backspace são teclas: descartar o que não tem trim apagava a
  // fronteira entre palavras quando cada tecla chega num chunk.
  if (text.length === 0) return;
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
 * como palavra (espaço/hífen opcionais; apelido de 4+ letras tolera uma
 * edição, ex. "qwhen" → qwen). Apelido curto ("glm") fica exato. Sem sessão
 * → false (o pin volta a ser preferência).
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
  const normalized = normalizeForMatch(replayInput(recent));
  return aliasesFor(adapterId).some((alias) => aliasMatches(normalized, alias));
}
