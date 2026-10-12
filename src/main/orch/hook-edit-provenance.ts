/**
 * F-1237: autoria por proveniência, não por data. O PostToolUse de edição que
 * o CLI manda pelo hook de status (`/hook/status`, bearer do próprio pane)
 * vira um registro durável "a conversa X editou o arquivo Y nesta raiz". O
 * portão de regressão de um pane que retoma exatamente a conversa X conta Y
 * como dele — o mtime sozinho não separa "minha edição de ontem" de "WIP do
 * outro agente de ontem".
 *
 * Eventos usados (PostToolUse → `tool-complete`):
 * - família Claude: `Edit` / `Write` / `MultiEdit` (`tool_input.file_path`) e
 *   `NotebookEdit` (`tool_input.notebook_path`);
 * - Codex: `apply_patch` (cabeçalhos `*** Add|Update|Delete File:` e
 *   `*** Move to:` do patch em `tool_input`);
 * - F-1284: Kimi/Grok e afins, com os nomes que o produto já trata como
 *   edição (`str_replace`, `write_file`, `edit_file`, `write_to_file`,
 *   `replace_file_content`, `multi_replace_file_content`).
 * CLI sem evento de edição com caminho não registra nada: o portão segue como
 * antes (na dúvida, não culpa o pane).
 *
 * Segurança — só pode APERTAR o portão contra o próprio agente:
 * - o pane vem do bearer (o Main resolveu a sessão PTY), nunca do corpo;
 * - a conversa é a do argv que o Main montou (`--resume <id>` ou o
 *   `--session-id` ditado); sem id no argv, a que o próprio CLI anunciou no
 *   SessionStart deste bearer, desde que nenhum outro pane já a tenha
 *   (F-1241). O `session_id` do corpo só precisa CONCORDAR — outra conversa
 *   é descartada;
 * - o caminho é normalizado e confinado à raiz de execução do pane (realpath
 *   do diretório); fora dela, descartado;
 * - o registro só move arquivo SUJO de "alheio" para "do agente" no portão do
 *   próprio pane retomado; nunca toca o portão de outra sessão.
 * F-1242: grava o sha256 do conteúdo lido no PostToolUse (arquivo regular,
 * confinado, até 1 MB); o portão só conta como da conversa o arquivo cujo
 * conteúdo ainda é esse. A leitura é assíncrona e serializada por sessão.
 * F-1249: o CLI roda os hooks PostToolUse em paralelo; o formatador do usuário
 * pode reescrever o arquivo depois do hash. No Stop do turno, a mesma sessão
 * re-hasheia os caminhos que o turno gravou e atualiza o sha (só linha que já
 * existe). O conjunto do turno some no Stop e no prompt seguinte: escrita
 * posterior, de quem for, não entra.
 * Falha aqui nunca derruba o hook (tudo em try, devolve 0).
 */
import fs from 'node:fs';
import path from 'node:path';
import type { AgentGateContext } from './gate';
import {
  getSessionProviderConversation,
  type SessionProviderConversation,
} from '../pty/pty-manager';
import {
  listConversationEdits,
  recordConversationEdits,
} from '../persistence/conversation-edit-store';
import { providerSessionHeldByOtherPane } from '../persistence/provider-session-store';
import { hashRegressionFile, normalizeRegressionPath } from '../regression-gate/regression-gate';

/** Ferramentas cujo `tool_input` traz o caminho editado. */
const PATH_EDIT_TOOLS = new Map<string, readonly string[]>([
  ['Edit', ['file_path']],
  ['Write', ['file_path']],
  ['MultiEdit', ['file_path']],
  ['NotebookEdit', ['notebook_path', 'file_path']],
  // F-1284: mesmos nomes e campos de agent-hook-listener/native-chat-diff.
  ['str_replace', ['path', 'file_path']],
  ['write_file', ['file_path', 'path']],
  ['edit_file', ['file_path', 'path']],
  ['write_to_file', ['TargetFile', 'path', 'file_path']],
  ['replace_file_content', ['TargetFile', 'path', 'file_path']],
  ['multi_replace_file_content', ['TargetFile', 'path', 'file_path']],
  // Revisão de ponta: nomes minúsculos do mapa do agent-hook-listener (escrita).
  ['create', ['path', 'file_path']],
  ['write', ['path', 'file_path']],
  ['edit', ['path', 'file_path']],
  ['patch', ['path', 'file_path']],
]);
/** Ferramentas de patch (Codex): os caminhos vêm dos cabeçalhos do patch. */
const PATCH_EDIT_TOOLS = new Set(['apply_patch']);
const PATCH_HEADER_RE = /^\*\*\* (?:(?:Add|Update|Delete) File|Move to): (.+)$/u;
export const MAX_RECORDED_PATHS_PER_EVENT = 128;
const MAX_PATCH_SCAN_CHARS = 4 * 1024 * 1024;
/** F-1242: eventos de edição na fila de hash de uma sessão; além disso, descarta. */
export const MAX_QUEUED_EDIT_EVENTS_PER_SESSION = 32;

/**
 * Conversa anunciada pelo próprio CLI no bearer do pane quando o argv não
 * traz id (Codex fresco). F-1241: só o SessionStart fixa (o do CLI chega antes
 * de qualquer comando do agente; um curl dele com outro evento não fixa
 * nada). A chave é o objeto de conversa do Session do pty-manager: o pin vive
 * e morre com a sessão viva, sem despejo por volume de spawns.
 */
let pinnedConversations = new WeakMap<SessionProviderConversation, string>();
/** Eventos em que o CLI anuncia a conversa (Codex: `session-start`; Kimi/Grok: `session`). */
const PIN_EVENT_TYPES: ReadonlySet<string> = new Set(['session-start', 'session']);
/**
 * F-1242: fila de hash por sessão viva (mesma chave do pin). Um evento de cada
 * vez lê arquivos; um curl em loop não multiplica leituras em paralelo no Main.
 */
let hashQueues = new WeakMap<SessionProviderConversation, { tail: Promise<unknown>; queued: number }>();
/** F-1249: fim do turno (o PostToolUse do turno, formatador incluso, já acabou). */
const TURN_END_EVENT_TYPES: ReadonlySet<string> = new Set(['stop', 'stop-failure']);
/** F-1249: caminhos gravados no turno em curso, por sessão viva (até o teto por evento). */
let turnEdits = new WeakMap<SessionProviderConversation, Set<string>>();

export function __resetHookEditProvenanceForTests(): void {
  pinnedConversations = new WeakMap();
  hashQueues = new WeakMap();
  turnEdits = new WeakMap();
}

function stringField(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text && text.length <= 512 ? text : null;
}

function patchTexts(input: unknown, depth = 0): string[] {
  if (typeof input === 'string') return [input];
  if (Array.isArray(input)) return input.filter((item): item is string => typeof item === 'string');
  if (!input || typeof input !== 'object' || depth >= 2) return [];
  const record = input as Record<string, unknown>;
  return ['command', 'input', 'patch', 'cmd'].flatMap((key) => patchTexts(record[key], depth + 1));
}

// F-1284: a triagem do corpo grande aceita exatamente as ferramentas de edição acima.
const EDIT_TOOL_HEAD_RE = new RegExp(
  `"tool_?[nN]ame"\\s*:\\s*"(?:${[...PATH_EDIT_TOOLS.keys(), ...PATCH_EDIT_TOOLS].join('|')})"`,
  'u',
);

/**
 * Corpo grande demais para o status: só vale ler (e parsear) se o começo já
 * diz que é uma ferramenta de edição. Na dúvida, não lê — nada registrado.
 */
export function hookBodyMayCarryEdit(head: string): boolean {
  return EDIT_TOOL_HEAD_RE.test(head);
}

/** Caminhos crus (absolutos ou relativos ao cwd do CLI) que o evento editou. */
export function extractEditedPaths(body: Record<string, unknown>): string[] {
  const tool = stringField(body.tool_name ?? body.toolName);
  if (!tool) return [];
  const input = body.tool_input ?? body.toolInput;
  const out = new Set<string>();
  const keys = PATH_EDIT_TOOLS.get(tool);
  if (keys && input && typeof input === 'object' && !Array.isArray(input)) {
    for (const key of keys) {
      const value = (input as Record<string, unknown>)[key];
      if (typeof value === 'string' && value.trim()) {
        out.add(value.trim());
        break;
      }
    }
  }
  if (PATCH_EDIT_TOOLS.has(tool) || (keys && out.size === 0)) {
    for (const text of patchTexts(input)) {
      for (const line of text.slice(0, MAX_PATCH_SCAN_CHARS).split(/\r?\n/u)) {
        // Cabeçalho do patch fica na coluna 0; linha de conteúdo (` `, `+`, `-`) não conta.
        const match = PATCH_HEADER_RE.exec(line.trimEnd());
        if (match?.[1]?.trim()) out.add(match[1].trim());
        if (out.size >= MAX_RECORDED_PATHS_PER_EVENT) break;
      }
    }
  }
  return [...out].slice(0, MAX_RECORDED_PATHS_PER_EVENT);
}

/**
 * Normaliza `raw` (resolvido contra `base`) e confina à raiz de execução.
 * Resolve symlinks pelo diretório existente mais fundo (o arquivo pode ter
 * sido apagado ou criado agora); o último componente fica como o git o vê.
 * Fora da raiz, em `.git/`, `.nexus/`, `node_modules/` ou inválido: null.
 */
export function confineEditedPath(rootRealPath: string, base: string, raw: string): string | null {
  try {
    const text = raw.trim();
    // eslint-disable-next-line no-control-regex -- recusa controles de propósito
    if (!text || text.length > 4096 || /[\u0000-\u001f\u007f]/u.test(text)) return null;
    const absolute = path.resolve(path.isAbsolute(base) ? base : rootRealPath, text);
    let dir = path.dirname(absolute);
    const tail = [path.basename(absolute)];
    let real: string | null = null;
    for (let depth = 0; depth < 128 && real === null; depth += 1) {
      try {
        real = fs.realpathSync.native(dir);
      } catch {
        const parent = path.dirname(dir);
        if (parent === dir) return null;
        tail.unshift(path.basename(dir));
        dir = parent;
      }
    }
    if (real === null) return null;
    const relative = path.relative(rootRealPath, path.join(real, ...tail));
    if (!relative || path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) {
      return null;
    }
    return normalizeRegressionPath(relative.split(path.sep).join('/'));
  } catch {
    return null;
  }
}

/** Conversa deste PTY a que o evento pertence, ou null (não registra). */
function boundConversation(
  conversation: SessionProviderConversation,
  claimed: string,
  eventType: string,
  heldByOtherPane: NonNullable<HookEditProvenanceDeps['heldByOtherPane']>,
): string | null {
  if (conversation.conversationId) return claimed === conversation.conversationId ? claimed : null;
  const pinned = pinnedConversations.get(conversation);
  if (pinned !== undefined) return claimed === pinned ? claimed : null;
  // F-1241: só o SessionStart fixa, e nunca a conversa que outro pane já tem
  // (um pin forjado faria as edições deste pane contarem no portão do outro).
  if (!PIN_EVENT_TYPES.has(eventType) || heldByOtherPane(conversation, claimed)) return null;
  pinnedConversations.set(conversation, claimed);
  return claimed;
}

export interface HookEditProvenanceDeps {
  readonly conversationOf?: (sessionId: string) => SessionProviderConversation | null;
  /** F-1241: `provider_pane_sessions` já dá a conversa a outro pane. */
  readonly heldByOtherPane?: (conversation: SessionProviderConversation, claimed: string) => boolean;
  readonly record?: typeof recordConversationEdits;
  readonly hash?: typeof hashRegressionFile;
  readonly now?: () => number;
}

type ProvenanceContext = Pick<AgentGateContext, 'sessionId'> &
  Partial<Pick<AgentGateContext, 'scope' | 'executionScope'>>;

/**
 * Hook de status autenticado pelo bearer do pane: fixa a conversa anunciada
 * (quando o argv não trouxe id) e, no `tool-complete` de uma edição, grava os
 * caminhos confinados à raiz com o sha256 do conteúdo no disco. Devolve
 * quantos gravou; nunca rejeita.
 */
export async function recordHookEditProvenance(
  ctx: ProvenanceContext,
  eventType: string,
  body: Record<string, unknown>,
  deps: HookEditProvenanceDeps = {},
): Promise<number> {
  try {
    const sessionId = ctx.sessionId;
    const scope = ctx.executionScope ?? ctx.scope;
    if (!sessionId || !scope?.rootRealPath) return 0;
    const conversation = (deps.conversationOf ?? getSessionProviderConversation)(sessionId);
    const claimed = stringField(body.session_id ?? body.sessionId);
    if (!conversation || !claimed) return 0;
    const conversationId = boundConversation(
      conversation,
      claimed,
      eventType,
      deps.heldByOtherPane ??
        ((own, id) => providerSessionHeldByOtherPane(own.adapterId, id, own.paneId)),
    );
    if (!conversationId) return 0;
    if (eventType === 'user-submit') turnEdits.delete(conversation);
    const turnEnd = TURN_END_EVENT_TYPES.has(eventType);
    if (!turnEnd && eventType !== 'tool-complete') return 0;
    const root = scope.rootRealPath;
    const cwd = typeof body.cwd === 'string' && path.isAbsolute(body.cwd) ? body.cwd : root;
    const turn = turnEdits.get(conversation);
    if (turnEnd) turnEdits.delete(conversation);
    const relPaths = turnEnd
      ? [...(turn ?? [])]
      : extractEditedPaths(body)
        .map((file) => confineEditedPath(root, cwd, file))
        .filter((file): file is string => file !== null);
    if (relPaths.length === 0) return 0;
    const queue = hashQueues.get(conversation) ?? { tail: Promise.resolve(), queued: 0 };
    hashQueues.set(conversation, queue);
    if (queue.queued >= MAX_QUEUED_EDIT_EVENTS_PER_SESSION) return 0;
    if (!turnEnd) {
      const current = turn ?? new Set<string>();
      turnEdits.set(conversation, current);
      for (const rel of relPaths) if (current.size < MAX_RECORDED_PATHS_PER_EVENT) current.add(rel);
    }
    queue.queued += 1;
    const job = queue.tail.then(async () => {
      // O conteúdo que a edição deixou: lido agora, depois da escrita do CLI.
      // No fim do turno, relido depois dos hooks paralelos (formatador).
      const edits = new Map<string, string>();
      for (const rel of relPaths) {
        const sha256 = await (deps.hash ?? hashRegressionFile)(root, rel);
        if (sha256) edits.set(rel, sha256);
      }
      if (edits.size === 0) return 0;
      return (deps.record ?? recordConversationEdits)(
        { scope: conversation.scope, adapterId: conversation.adapterId, conversationId, rootRealPath: root },
        edits,
        (deps.now ?? Date.now)(),
        undefined,
        !turnEnd,
      );
    });
    queue.tail = job.catch(() => 0).finally(() => {
      queue.queued -= 1;
    });
    return await job;
  } catch {
    return 0;
  }
}

/**
 * Portão de regressão: edições registradas pela conversa que esta sessão
 * RETOMOU exatamente, nesta raiz. `undefined` para spawn fresco (tudo o que
 * ele escreveu é posterior ao spawn) ou sem registro; nunca lança.
 */
export function recordedEditsForSession(
  sessionId: string | undefined,
  rootRealPath: string | undefined,
  deps: {
    readonly conversationOf?: (sessionId: string) => SessionProviderConversation | null;
    readonly list?: typeof listConversationEdits;
  } = {},
): ReadonlyMap<string, string> | undefined {
  try {
    if (!sessionId || !rootRealPath) return undefined;
    const conversation = (deps.conversationOf ?? getSessionProviderConversation)(sessionId);
    if (!conversation?.resumed || !conversation.conversationId) return undefined;
    const edits = (deps.list ?? listConversationEdits)({
      scope: conversation.scope,
      adapterId: conversation.adapterId,
      conversationId: conversation.conversationId,
      rootRealPath,
    });
    return edits.size > 0 ? edits : undefined;
  } catch {
    return undefined;
  }
}
