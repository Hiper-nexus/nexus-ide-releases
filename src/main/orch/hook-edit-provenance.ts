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
 *   `*** Move to:` do patch em `tool_input`).
 * CLI sem evento de edição com caminho não registra nada: o portão segue como
 * antes (na dúvida, não culpa o pane).
 *
 * Segurança — só pode APERTAR o portão contra o próprio agente:
 * - o pane vem do bearer (o Main resolveu a sessão PTY), nunca do corpo;
 * - a conversa é a do argv que o Main montou (`--resume <id>` ou o
 *   `--session-id` ditado); sem id no argv, a primeira que o próprio CLI
 *   anunciou neste bearer. O `session_id` do corpo só precisa CONCORDAR —
 *   outra conversa é descartada;
 * - o caminho é normalizado e confinado à raiz de execução do pane (realpath
 *   do diretório); fora dela, descartado;
 * - o registro só move arquivo SUJO de "alheio" para "do agente" no portão do
 *   próprio pane retomado; nunca toca o portão de outra sessão.
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
import { normalizeRegressionPath } from '../regression-gate/regression-gate';

/** Ferramentas cujo `tool_input` traz o caminho editado. */
const PATH_EDIT_TOOLS = new Map<string, readonly string[]>([
  ['Edit', ['file_path']],
  ['Write', ['file_path']],
  ['MultiEdit', ['file_path']],
  ['NotebookEdit', ['notebook_path', 'file_path']],
]);
/** Ferramentas de patch (Codex): os caminhos vêm dos cabeçalhos do patch. */
const PATCH_EDIT_TOOLS = new Set(['apply_patch']);
const PATCH_HEADER_RE = /^\*\*\* (?:(?:Add|Update|Delete) File|Move to): (.+)$/u;
export const MAX_RECORDED_PATHS_PER_EVENT = 128;
const MAX_PATCH_SCAN_CHARS = 4 * 1024 * 1024;
const MAX_PINNED_SESSIONS = 1024;

/**
 * Conversa anunciada pelo próprio CLI no bearer do pane quando o argv não
 * traz id (Codex fresco). O primeiro evento do canal é do CLI (SessionStart /
 * prompt / PreToolUse chegam antes de qualquer comando do agente rodar).
 */
const pinnedConversations = new Map<string, string>();

export function __resetHookEditProvenanceForTests(): void {
  pinnedConversations.clear();
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

const EDIT_TOOL_HEAD_RE = /"tool_?[nN]ame"\s*:\s*"(?:Edit|Write|MultiEdit|NotebookEdit|apply_patch)"/u;

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
  sessionId: string,
  conversation: SessionProviderConversation,
  claimed: string,
): string | null {
  if (conversation.conversationId) return claimed === conversation.conversationId ? claimed : null;
  const pinned = pinnedConversations.get(sessionId);
  if (pinned !== undefined) return claimed === pinned ? claimed : null;
  pinnedConversations.set(sessionId, claimed);
  while (pinnedConversations.size > MAX_PINNED_SESSIONS) {
    pinnedConversations.delete(pinnedConversations.keys().next().value!);
  }
  return claimed;
}

export interface HookEditProvenanceDeps {
  readonly conversationOf?: (sessionId: string) => SessionProviderConversation | null;
  readonly record?: typeof recordConversationEdits;
  readonly now?: () => number;
}

type ProvenanceContext = Pick<AgentGateContext, 'sessionId'> &
  Partial<Pick<AgentGateContext, 'scope' | 'executionScope'>>;

/**
 * Hook de status autenticado pelo bearer do pane: fixa a conversa anunciada
 * (quando o argv não trouxe id) e, no `tool-complete` de uma edição, grava os
 * caminhos confinados à raiz. Devolve quantos gravou; nunca lança.
 */
export function recordHookEditProvenance(
  ctx: ProvenanceContext,
  eventType: string,
  body: Record<string, unknown>,
  deps: HookEditProvenanceDeps = {},
): number {
  try {
    const sessionId = ctx.sessionId;
    const scope = ctx.executionScope ?? ctx.scope;
    if (!sessionId || !scope?.rootRealPath) return 0;
    const conversation = (deps.conversationOf ?? getSessionProviderConversation)(sessionId);
    const claimed = stringField(body.session_id ?? body.sessionId);
    if (!conversation || !claimed) return 0;
    const conversationId = boundConversation(sessionId, conversation, claimed);
    if (!conversationId || eventType !== 'tool-complete') return 0;
    const raw = extractEditedPaths(body);
    if (raw.length === 0) return 0;
    const root = scope.rootRealPath;
    const cwd = typeof body.cwd === 'string' && path.isAbsolute(body.cwd) ? body.cwd : root;
    const relPaths = raw
      .map((file) => confineEditedPath(root, cwd, file))
      .filter((file): file is string => file !== null);
    if (relPaths.length === 0) return 0;
    return (deps.record ?? recordConversationEdits)(
      { scope: conversation.scope, adapterId: conversation.adapterId, conversationId, rootRealPath: root },
      relPaths,
      (deps.now ?? Date.now)(),
    );
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
): ReadonlyMap<string, number> | undefined {
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
