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
 * chunk (colagem gigante fica com o final — F-1303). A menção é detectada NA
 * HORA em que o chunk entra e vira só um timestamp (`lastNamedAt`): texto
 * posterior não a apaga (F-1303, 2ª rodada).
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

/**
 * F-1303 (2ª rodada): menção detectada quando o chunk ENTROU. O buffer por
 * sessão ainda evicta pelo teto de 4.000 — texto humano digitado depois de uma
 * menção (mais entregas coladas no pane) empurrava "kimi code mesmo" para fora
 * em ~23 min. Aqui só o timestamp fica; mesma retenção de 30 min, só em RAM.
 */
const lastNamedAtBySession = new Map<string, Map<string, number>>();

/**
 * F-1418: horários em que o operador APERTOU Enter no pane (input humano com
 * \r/\n). Só timestamps, mesma retenção de 30 min. Prova que um prompt que a
 * TUI registrou (sugestão aceita, mensagem absorvida no meio do turno) foi
 * enviado pela mão humana — o texto em si nunca passou pelo tap.
 */
const humanSubmitsBySession = new Map<string, number[]>();
const MAX_SUBMITS_PER_SESSION = 64;

let installed = false;

/**
 * Aliases conhecidos → adapter: id da CLI, nomes de uso comum e o nome dos
 * modelos carro-chefe (F-1418: "devin swe2"/"swe-2", "wonder" do Muse). O
 * próprio id do adapter sempre conta (ver `aliasesFor`). Nome que é palavra
 * comum de pt/en fica FORA (F-818): "sol"/"luna"/"terra" (Codex), "spark"
 * (Muse), "argon" (agy). "wonder" é exceção pedida pelo operador (é o nome
 * que ele usa para o Muse Wonder Full); o pin ainda exige `operatorChoice`.
 */
const CLI_MENTION_ALIASES: Readonly<Record<string, readonly string[]>> = {
  claude: ['claude', 'claude code', 'opus', 'sonnet', 'haiku', 'fable', 'mythos', 'anthropic'],
  codex: ['codex', 'gpt', 'chatgpt', 'astra', 'openai'],
  grok: ['grok', 'xai'],
  agy: ['agy', 'gemini', 'antigravity'],
  kimi: ['kimi', 'moonshot'],
  glm: ['glm', 'zai', 'z.ai'],
  'glm-flash': ['glm', 'zai', 'z.ai'],
  'mimo-code': ['mimo', 'xiaomi'],
  'minimax-code': ['minimax'],
  devin: ['devin', 'swe', 'swe2', 'windsurf'],
  longcat: ['longcat', 'meituan'],
  muse: ['muse', 'wonder'],
  'muse-claude': ['muse'],
  deepseek: ['deepseek'],
  opencode: ['opencode', 'big pickle'],
  openclaude: ['openclaude'],
  aider: ['aider'],
  qwen: ['qwen', 'qwen code', 'qwen 3.8'],
};

/** Adapters conhecidos: a detecção na entrada varre todos (o spawn que pergunta pode ser qualquer um). */
const KNOWN_ADAPTER_IDS = Object.keys(CLI_MENTION_ALIASES);

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
  claude: ['cluade', 'claud', 'calude', 'cloude', 'claudee'],
  sonnet: ['sonet', 'sonnett'],
  codex: ['codx', 'cdex', 'codexx', 'coddex'],
  grok: ['grook', 'grokk'],
  gemini: ['gemni', 'geminy', 'gemeni'],
  antigravity: ['antigravit', 'antigraviti', 'antigravty', 'antigrav'],
  kimi: ['kimmi', 'kimy'],
  minimax: ['minimaxx', 'minimx', 'minmiax'],
  mimo: ['mimmo'],
  devin: ['devim', 'devinn', 'deivin', 'devni', 'dvein'],
  muse: ['musse', 'muze'],
  wonder: ['wondr', 'woder'],
  deepseek: ['deepsek', 'depseek', 'dipseek', 'deepseak'],
  opencode: ['opencod', 'opnecode'],
  openclaude: ['openclaud'],
  qwen: ['qwhen', 'quen', 'qwem'],
  xiaomi: ['xiomi', 'xiaomy'],
};

/* eslint-disable no-control-regex -- os padrões removem sequências ANSI (ESC/BEL) de propósito */
const OSC_PATTERN = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
// F-1406: [0-?]* (ECMA-48, 0x30–0x3F) cobre os parâmetros privados
// (ESC[>4;0m/ESC[>7u do Codex 0.162) que a classe antiga [0-9;?] deixava no
// buffer. Introducer literal — SEM a forma C1 de 8 bits do padrão
// compartilhado: este tap roda em toda tecla do operador e a alternativa
// extra estourava o teto linear do F-818.
const CSI_PATTERN = /\x1b\[[0-?]*[ -\/]*[@-~]/g;
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

/** F-1418: o id do adapter sempre conta, além dos aliases da família. */
function aliasesFor(adapterId: string): readonly string[] {
  const aliases = CLI_MENTION_ALIASES[adapterId] ?? [];
  return aliases.includes(adapterId) ? aliases : [adapterId, ...aliases];
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** "anti gravity" / "anti-gravity" casam "antigravity". Apelido curto fica exato. */
function flexibleAliasPattern(core: string): RegExp {
  const parts = [...core].map((ch) => escapeRegex(ch));
  return new RegExp(`(?<![a-z0-9])${parts.join('[\\s-]*')}(?![a-z0-9])`, 'u');
}

function aliasPatterns(alias: string): RegExp[] {
  const core = alias.replace(/[\s-]+/g, '');
  if (core.length < 4) {
    return [new RegExp(`(?<![a-z0-9])${escapeRegex(alias)}(?![a-z0-9])`, 'u')];
  }
  return [
    flexibleAliasPattern(core),
    // F-818: só grafia errada EXPLÍCITA — sem distância de edição genérica.
    ...(CLI_MENTION_TYPOS[alias] ?? []).map((typo) => flexibleAliasPattern(typo)),
  ];
}

function aliasMatches(text: string, alias: string): boolean {
  const normalizedAlias = normalizeForMatch(alias);
  if (!normalizedAlias) return false;
  return aliasPatterns(normalizedAlias).some((pattern) => pattern.test(text));
}

/**
 * F-1303 (2ª rodada): a detecção cobre só o chunk NOVO, com o final do replay
 * anterior emprestado para a fronteira de palavra do empalme ("cade gro" +
 * "k"). ponytail: 64 chars de cauda bastam para o alias mais longo com o
 * espaço/hífen flexível; um nome "esticado" por mais de ~50 chars de branco
 * entre as letras não é uma menção.
 */
const DETECTION_TAIL_CHARS = 64;

/**
 * F-1303 (revisão Fable): casamento NOVO do alias na junção. O fim do texto
 * não é fronteira direita numa tecla solta ("swe" de "sweep", "muse" de
 * "museu", "quen" de "quente", "codex" de "codexes") — só um caractere real
 * depois do nome; colagem é texto completo e aceita o fim. 'new' = termina
 * depois do empalme; 'deferred' = terminou na cauda e o separador/Enter que
 * o confirma chegou agora (re-varredura da cauda).
 */
function newAliasMatch(
  text: string,
  alias: string,
  boundary: number,
  acceptTextEnd: boolean,
): 'new' | 'deferred' | null {
  let found: 'deferred' | null = null;
  for (const pattern of aliasPatterns(alias)) {
    const global = new RegExp(pattern.source, `${pattern.flags}g`);
    for (let match = global.exec(text); match !== null; match = global.exec(text)) {
      const end = match.index + match[0].length;
      if (end < boundary) continue;
      if (end === text.length && !(acceptTextEnd && end > boundary)) continue;
      if (end > boundary) return 'new';
      found = 'deferred';
    }
  }
  return found;
}

function markNamed(
  sessionId: string,
  at: number,
  previousAt: number | undefined,
  previousReplay: string,
  chunkText: string,
): void {
  const tail = previousReplay.slice(-DETECTION_TAIL_CHARS);
  const junction = normalizeForMatch(
    replayInput([{ at, text: tail }, { at, text: chunkText }]),
  );
  const boundary = normalizeForMatch(tail).length;
  const acceptTextEnd = isPasteChunk(chunkText);
  let byAdapter = lastNamedAtBySession.get(sessionId);
  if (!byAdapter) {
    byAdapter = new Map();
    lastNamedAtBySession.set(sessionId, byAdapter);
  }
  for (const adapterId of KNOWN_ADAPTER_IDS) {
    let namedAt: number | undefined;
    for (const alias of aliasesFor(adapterId)) {
      const found = newAliasMatch(junction, normalizeForMatch(alias), boundary, acceptTextEnd);
      if (found === 'new') {
        namedAt = at;
        break;
      }
      // Confirmado pelo separador: a menção é da hora da última letra — um
      // Enter tardio não renova a prova.
      if (found === 'deferred') namedAt = previousAt;
    }
    if (namedAt !== undefined) {
      byAdapter.set(adapterId, Math.max(namedAt, byAdapter.get(adapterId) ?? namedAt));
    }
  }
  for (const [adapterId, namedAt] of byAdapter) {
    if (at - namedAt > RETENTION_MS) byAdapter.delete(adapterId);
  }
  if (byAdapter.size === 0) lastNamedAtBySession.delete(sessionId);
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
  const retained = (inputBySession.get(sessionId) ?? []).filter(
    (chunk) => now - chunk.at <= RETENTION_MS,
  );
  // Detecção na hora (F-1303, 2ª rodada): só o chunk novo é varrido — o final
  // do replay anterior entra só como fronteira de palavra. Antes da evicção,
  // para não perder o que está prestes a sair do buffer.
  markNamed(sessionId, now, retained.at(-1)?.at, replayInput(retained), clipped);
  const chunks = [...retained, { at: now, text: clipped }];
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

function noteHumanSubmit(sessionId: string, at: number): void {
  const kept = (humanSubmitsBySession.get(sessionId) ?? []).filter(
    (t) => at - t <= RETENTION_MS,
  );
  kept.push(at);
  humanSubmitsBySession.set(sessionId, kept.slice(-MAX_SUBMITS_PER_SESSION));
}

/**
 * F-1418: folga entre o Enter humano no tap e o carimbo que a TUI grava no
 * prompt (o Claude Code grava ~100 ms depois; 5 s cobre main lento). Enter
 * DEPOIS do carimbo só vale até 1 s (relógios do mesmo host).
 */
export const HUMAN_SUBMIT_BEFORE_MS = 5_000;
export const HUMAN_SUBMIT_AFTER_MS = 1_000;

/** Prompt que a própria CLI registrou como enviado pelo humano (transcript). */
export interface SubmittedOperatorPrompt {
  readonly at: number;
  readonly text: string;
}

/**
 * F-1418: o operador nomeou a CLI num prompt que a TUI registrou — sugestão
 * aceita com Enter/Tab ou mensagem absorvida no meio do turno, cujo TEXTO não
 * passa pelo tap (só a tecla). Vale quando o prompt está na janela, nomeia a
 * CLI e há um Enter HUMANO no tap colado ao carimbo do prompt; texto injetado
 * pelo Nexus (handoff, kickoff) é enviado por Enter `system` e não casa.
 */
export function operatorSubmittedPromptNamesCli(
  sessionId: string | undefined,
  adapterId: string,
  prompts: readonly SubmittedOperatorPrompt[],
  now = Date.now(),
  windowMs = OPERATOR_CHOICE_PROOF_WINDOW_MS,
): boolean {
  if (!sessionId) return false;
  const submits = humanSubmitsBySession.get(sessionId);
  if (!submits || submits.length === 0) return false;
  const window = Math.min(windowMs, RETENTION_MS);
  return prompts.some((prompt) =>
    Number.isFinite(prompt.at) &&
    now - prompt.at >= 0 &&
    now - prompt.at <= window &&
    submits.some((t) =>
      t >= prompt.at - HUMAN_SUBMIT_BEFORE_MS && t <= prompt.at + HUMAN_SUBMIT_AFTER_MS) &&
    textNamesCli(prompt.text, adapterId));
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
    if (/[\r\n]/u.test(data)) noteHumanSubmit(sessionId, Date.now());
    remember(sessionId, data);
  });
  const untapExit = tapSessionExit((sessionId) => {
    inputBySession.delete(sessionId);
    lastNamedAtBySession.delete(sessionId);
    humanSubmitsBySession.delete(sessionId);
  });
  return () => {
    untapInput();
    untapExit();
    inputBySession.clear();
    lastNamedAtBySession.clear();
    humanSubmitsBySession.clear();
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
  const window = Math.min(windowMs, RETENTION_MS);
  // F-1303 (2ª rodada): a menção detectada quando o chunk entrou não depende
  // mais do buffer — texto posterior não a apaga.
  const namedAt = lastNamedAtBySession.get(sessionId)?.get(adapterId);
  if (namedAt !== undefined && now - namedAt >= 0 && now - namedAt <= window) {
    return true;
  }
  const chunks = inputBySession.get(sessionId);
  if (!chunks || chunks.length === 0) return false;
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
