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
 * retenção de 30 minutos, teto de 4.000 caracteres por sessão e de 1.000 por
 * chunk (colagem gigante fica com o final — F-1303).
 */
import { tapSessionExit, tapSessionInput } from '../pty/pty-manager';

const MENTION_WINDOW_MS = 15 * 60_000;
const RETENTION_MS = 30 * 60_000;
const MAX_RETAINED_CHARS = 4_000;
/**
 * Teto por CHUNK (fica o FINAL): um write humano maior que isso — colagem de
 * handoff no compositor — não pode monopolizar o buffer nem, pior, deixar o
 * laço de evicção remover TODOS os chunks junto com ele (F-1303: a menção
 * "kimi…" sumia do buffer e o operatorChoice era redistribuído).
 * ponytail: colagem que chega em MUITOS writes de 1.000 chars cada ainda
 * evicta chunks antigos pelo teto da sessão; segurar isso exige orçamento
 * reservado por tipo de chunk no tap.
 */
const MAX_CHUNK_CHARS = 1_000;

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

/**
 * F-818: erros de digitação CONHECIDOS por alias (chave = alias normalizado).
 * Substitui a distância de 1 edição do F-766, que "provava" que o operador
 * nomeou uma CLI com palavras comuns ("mude"/"mouse" → muse, "devia" → devin,
 * "minimal" → minimax, "memo"/"mito" → mimo, "table"/"clause" → claude,
 * "cursos" → cursor): prova de pedido exige o nome ou uma grafia errada
 * explícita, nunca uma palavra vizinha. Entrada nova só entra se NÃO for
 * palavra de pt/en; o espaço/hífen flexível ("qwen 3.8", "anti gravity") vale
 * para a grafia errada também. Grafia errada fora da lista só vira
 * preferência (o pin é redistribuído), nunca escolha provada.
 */
const CLI_MENTION_TYPOS: Readonly<Record<string, readonly string[]>> = {
  claude: ['cluade', 'claud', 'calude'],
  sonnet: ['sonet', 'sonnett'],
  codex: ['codx', 'cdex'],
  grok: ['grook', 'grokk'],
  gemini: ['gemni', 'geminy', 'gemeni'],
  kimi: ['kimmi', 'kimy'],
  minimax: ['minimaxx', 'minimx'],
  devin: ['devim'],
  muse: ['musse'],
  deepseek: ['deepsek', 'depseek', 'dipseek', 'deepseak'],
  opencode: ['opencod', 'opnecode'],
  openclaude: ['openclaud'],
  qwen: ['qwhen', 'quen', 'qwem'],
  xiaomi: ['xiomi', 'xiaomy'],
};

/* eslint-disable no-control-regex -- os padrões removem sequências ANSI (ESC/BEL) de propósito */
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
  // F-818: só grafia errada EXPLÍCITA — sem distância de edição genérica.
  return (CLI_MENTION_TYPOS[normalizedAlias] ?? []).some((typo) =>
    flexibleAliasPattern(typo).test(text),
  );
}

function remember(sessionId: string, data: string): void {
  const text = sanitizeInput(data);
  // Espaço e backspace são teclas: descartar o que não tem trim apagava a
  // fronteira entre palavras quando cada tecla chega num chunk.
  if (text.length === 0) return;
  const now = Date.now();
  // F-1303: chunk maior que o teto por chunk fica com o FINAL (sem ele, o
  // laço abaixo removia o próprio chunk e TODOS os anteriores — um write de
  // 10 KB evaporava a sessão inteira).
  const clipped =
    text.length > MAX_CHUNK_CHARS ? text.slice(-MAX_CHUNK_CHARS) : text;
  const chunks = [...(inputBySession.get(sessionId) ?? []), { at: now, text: clipped }]
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
 * como palavra (espaço/hífen opcionais) ou uma grafia errada explícita da
 * tabela `CLI_MENTION_TYPOS` ("qwhen" → qwen); palavra comum parecida não conta
 * (F-818). Apelido curto ("glm") fica exato. Sem sessão → false (o pin volta a
 * ser preferência).
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
  return textNamesCli(replayInput(recent), adapterId);
}

/**
 * Pura: o texto nomeia esta CLI? Alias como palavra (espaço/hífen opcionais)
 * ou grafia errada explícita (F-818). Varredura linear no tamanho do texto
 * (nenhum quantificador aninhado; teste de tempo com 16 KB adversarial).
 */
export function textNamesCli(text: string, adapterId: string): boolean {
  const normalized = normalizeForMatch(text);
  return aliasesFor(adapterId).some((alias) => aliasMatches(normalized, alias));
}
