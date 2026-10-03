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

/**
 * Categoria da tool. O nome decide quando é específico; senão vale a
 * categoria declarada pelo emissor (o `kind` do ACP), se for do vocabulário;
 * nome sem categoria conhecida é `other`. Sem nome nem categoria: `null` —
 * honestidade em vez de palpite.
 */
export function observerToolKind(
  toolName: unknown,
  declaredKind?: unknown,
): ObserverToolKind | null {
  const named = typeof toolName === 'string' ? kindFromName(toolName) : null;
  if (named !== null && named !== 'other') return named;
  if (isObserverToolKind(declaredKind)) return declaredKind;
  return named;
}
