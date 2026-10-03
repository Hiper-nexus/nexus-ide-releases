/**
 * F-780: categoria de uma tool chamada por um agente, derivada só do NOME que
 * o hook (ou o ACP) já reporta — nunca de argumento ou conteúdo. É ela que
 * deixa o journal da missão responder "o navegador interno, as skills e as
 * tools do Nexus estão sendo usados?" sem reler transcript: a auditoria de
 * 03/10 (docs/analysis/2026-10-03-missao-terminais/06-uso-real.md) só
 * conseguiu contar abrindo os .jsonl de cada CLI.
 *
 * Vocabulário: o do ACP onde ele existe (read/search/edit/execute/fetch… —
 * o mesmo campo `kind` que o acp-observer-bridge já grava) e o do Nexus onde
 * o ACP não separa o que a pergunta do operador precisa separar.
 *
 * Roda a cada tool call no Main (projeção do quadro do observer): fatia o
 * nome, compara prefixos e consulta um Map — custo linear e limitado por
 * TOOL_NAME_SCAN_MAX, sem regex com retrocesso.
 */
export const OBSERVER_TOOL_KINDS = [
  // Nexus: o que a pergunta "estão usando de verdade?" quer separar.
  'nexus-browser',
  'nexus',
  'mcp',
  'skill',
  'web-search',
  // Shell que começa com curl/wget: a métrica "curl × navegador do Nexus"
  // sem guardar o comando (derivada no hook, ver isShellHttpCommand).
  'shell-http',
  'agent',
  // ACP (ToolKind), o mesmo vocabulário que o acp-observer-bridge grava.
  'read',
  'edit',
  'delete',
  'move',
  'search',
  'execute',
  'think',
  'fetch',
  'switch_mode',
  'other',
] as const;
export type ObserverToolKind = (typeof OBSERVER_TOOL_KINDS)[number];

const KNOWN_KINDS: ReadonlySet<string> = new Set(OBSERVER_TOOL_KINDS);

/** Nome de tool é rótulo, não payload: além disto nada muda a categoria. */
const TOOL_NAME_SCAN_MAX = 200;

/**
 * Tools nativas por nome normalizado (minúsculas, só letras e dígitos), para
 * que `WebFetch`, `web_fetch` e `FetchURL` caiam na mesma linha. Os nomes vêm
 * das CLIs que o Nexus roda — inclusive os que a missão Terminais gravou
 * (`run_terminal_command`, `search_replace`, `collaborationspawn_agent`…).
 */
const NATIVE_TOOL_KINDS: ReadonlyMap<string, ObserverToolKind> = new Map([
  // Página fora do navegador do Nexus — o que o F-781 quer ver cair.
  ['webfetch', 'fetch'],
  ['fetchurl', 'fetch'],
  ['fetchcontent', 'fetch'],
  ['readurlcontent', 'fetch'],
  ['websearch', 'web-search'],
  ['googlewebsearch', 'web-search'],
  ['searchweb', 'web-search'],
  ['skill', 'skill'],
  ['bash', 'execute'],
  ['shell', 'execute'],
  ['localshell', 'execute'],
  ['execcommand', 'execute'],
  ['shellcommand', 'execute'],
  ['runshellcommand', 'execute'],
  ['runcommand', 'execute'],
  ['runterminalcmd', 'execute'],
  ['runterminalcommand', 'execute'],
  ['powershell', 'execute'],
  ['read', 'read'],
  ['readfile', 'read'],
  ['readmanyfiles', 'read'],
  ['view', 'read'],
  ['viewfile', 'read'],
  ['viewimage', 'read'],
  ['notebookread', 'read'],
  ['grep', 'search'],
  ['glob', 'search'],
  ['ls', 'search'],
  ['listdir', 'search'],
  ['listdirectory', 'search'],
  ['grepsearch', 'search'],
  ['findbyname', 'search'],
  ['searchfilecontent', 'search'],
  ['edit', 'edit'],
  ['multiedit', 'edit'],
  ['write', 'edit'],
  ['writefile', 'edit'],
  ['notebookedit', 'edit'],
  ['applypatch', 'edit'],
  ['editfile', 'edit'],
  ['replace', 'edit'],
  ['searchreplace', 'edit'],
  ['strreplacefile', 'edit'],
  ['writetofile', 'edit'],
  ['replacefilecontent', 'edit'],
  ['multireplacefilecontent', 'edit'],
  ['task', 'agent'],
  ['agent', 'agent'],
  ['spawnagent', 'agent'],
  ['delegatetask', 'agent'],
  ['collaborationspawnagent', 'agent'],
  ['collaborationsendmessage', 'agent'],
  ['todowrite', 'think'],
  ['todolist', 'think'],
  ['updateplan', 'think'],
  ['exitplanmode', 'think'],
]);

export function isObserverToolKind(value: unknown): value is ObserverToolKind {
  return typeof value === 'string' && KNOWN_KINDS.has(value);
}

function kindFromName(raw: string): ObserverToolKind | null {
  const name = raw.trim().slice(0, TOOL_NAME_SCAN_MAX).toLowerCase();
  if (!name) return null;
  // MCP: Claude grava `mcp__<servidor>__<tool>`; o Codex, `<servidor>__<tool>`.
  // O servidor do Nexus aparece como `nexus` ou `nexus_<token>` (por sessão).
  const parts = name.split('__');
  const tool = parts[parts.length - 1] ?? '';
  if (tool.startsWith('nexus_browser_')) return 'nexus-browser';
  if (parts.length >= 2) {
    const server = (parts[0] === 'mcp' ? parts[1] : parts[0]) ?? '';
    if (server === 'nexus' || server.startsWith('nexus_') || tool.startsWith('nexus_')) {
      return 'nexus';
    }
    return 'mcp';
  }
  if (name.startsWith('nexus_')) return 'nexus';
  return NATIVE_TOOL_KINDS.get(name.replace(/[^a-z0-9]/g, '')) ?? 'other';
}

/** Categoria declarada que REFINA a do nome (shell que faz HTTP continua shell). */
const KIND_REFINEMENTS: Readonly<Partial<Record<ObserverToolKind, ReadonlySet<ObserverToolKind>>>> = {
  execute: new Set<ObserverToolKind>(['shell-http']),
};

/**
 * Categoria da tool. O nome decide quando é específico; a categoria declarada
 * pelo emissor (o `kind` do ACP, o `shell-http` do hook) só vale quando refina
 * a do nome ou quando o nome não diz nada; nome sem categoria conhecida é
 * `other`. Sem nome nem categoria: `null` — honestidade em vez de palpite.
 */
export function observerToolKind(
  toolName: unknown,
  declaredKind?: unknown,
): ObserverToolKind | null {
  const named = typeof toolName === 'string' ? kindFromName(toolName) : null;
  if (
    named !== null &&
    isObserverToolKind(declaredKind) &&
    KIND_REFINEMENTS[named]?.has(declaredKind)
  ) {
    return declaredKind;
  }
  if (named !== null && named !== 'other') return named;
  if (isObserverToolKind(declaredKind)) return declaredKind;
  return named;
}

// ── Nome da skill (F-780, complemento) ──────────────────────────────────────

const SKILL_NAME_MAX_LENGTH = 80;
/** Rótulo de catálogo em minúsculas: letras, dígitos, `:` (plugin:skill), `_` e `-`. */
const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9:_-]{0,79}$/;

/**
 * Nome da skill chamada pela tool `Skill` — o único argumento que sai do hook,
 * e só como rótulo: minúsculas e padrão estrito; o que não casa (espaço,
 * caminho, ponto, texto livre) não é gravado. Os demais argumentos da tool
 * nunca chegam aqui.
 */
export function normalizeSkillName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > SKILL_NAME_MAX_LENGTH) return null;
  const lower = trimmed.toLowerCase();
  return SKILL_NAME_PATTERN.test(lower) ? lower : null;
}

// ── Shell que faz HTTP (F-780, complemento) ─────────────────────────────────

/** O comando é argumento do agente, sem teto: só este prefixo é inspecionado. */
const SHELL_SCAN_MAX_CHARS = 512;
const SHELL_HTTP_CLIENTS: ReadonlySet<string> = new Set(['curl', 'wget']);
/** Prefixos que não mudam qual é o comando (`sudo curl`, `xargs curl`, `env X=1 curl`). */
const SHELL_WRAPPERS: ReadonlySet<string> = new Set([
  'sudo',
  'env',
  'time',
  'nohup',
  'command',
  'exec',
  'xargs',
]);
const SHELL_WORD_END: ReadonlySet<string> = new Set([
  ' ', '\t', '\r', '\n', ';', '|', '&', '(', ')', '<', '>', '"', "'", '`', '\\',
]);
const SHELL_ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

function isHttpClientWord(word: string): boolean {
  const base = word.slice(word.lastIndexOf('/') + 1).toLowerCase();
  return SHELL_HTTP_CLIENTS.has(base.endsWith('.exe') ? base.slice(0, -4) : base);
}

/**
 * Texto do comando como o hook o entrega: string, ou array argv (Codex:
 * `["bash","-lc","<script>"]`) — o primeiro elemento e o último (o script)
 * são os que podem nomear o cliente HTTP.
 */
function shellCommandText(command: unknown): string | null {
  if (typeof command === 'string') return command;
  if (!Array.isArray(command) || command.length === 0) return null;
  const words = command.filter((part): part is string => typeof part === 'string');
  if (words.length === 0) return null;
  return words.length === 1 ? words[0]! : `${words[0]}\n${words[words.length - 1]}`;
}

/**
 * O comando de shell começa com curl/wget — no início, depois de `cd … &&`,
 * `;`, `|`, `||`, quebra de linha, subshell ou crase, fora de aspas — nos
 * primeiros SHELL_SCAN_MAX_CHARS caracteres? Uma passada só, com estado de
 * aspas; sem regex sobre o texto inteiro. Heredoc (`<<`) encerra a leitura:
 * dali em diante é conteúdo, não comando. Heurística que erra para menos
 * (`timeout 10 curl …` e `bash -c "curl …"` não contam) e nunca guarda o
 * comando — só a categoria sai do hook.
 */
export function isShellHttpCommand(command: unknown): boolean {
  const text = shellCommandText(command);
  if (!text) return false;
  const source = text.slice(0, SHELL_SCAN_MAX_CHARS);
  let quote: '"' | "'" | null = null;
  let atCommandStart = true;
  let i = 0;
  while (i < source.length) {
    const ch = source[i]!;
    if (quote !== null) {
      if (ch === '\\' && quote === '"') {
        i += 2;
        continue;
      }
      if (ch === quote) quote = null;
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      atCommandStart = false;
      i += 1;
      continue;
    }
    if (ch === '\\') {
      atCommandStart = false;
      i += 2;
      continue;
    }
    if (ch === '<' && source[i + 1] === '<') return false;
    if (ch === ';' || ch === '|' || ch === '&' || ch === '\n' || ch === '(' || ch === '`') {
      atCommandStart = true;
      i += 1;
      continue;
    }
    if (SHELL_WORD_END.has(ch)) {
      i += 1;
      continue;
    }
    let end = i;
    while (end < source.length && !SHELL_WORD_END.has(source[end]!)) end += 1;
    const word = source.slice(i, end);
    i = end;
    if (!atCommandStart) continue;
    if (isHttpClientWord(word)) return true;
    const keepsCommandStart =
      SHELL_WRAPPERS.has(word.toLowerCase()) || SHELL_ENV_ASSIGNMENT.test(word);
    if (!keepsCommandStart) atCommandStart = false;
  }
  return false;
}
