// Adapted from pingdotgg/t3code @ 26285ab80513260d1ff29d2c3fbe18f21990cb62
// Copyright (c) 2026 T3 Tools Inc. — MIT License
// See third_party/licenses/t3code-MIT.txt. Nexus changes: requestAllCodexModels e parseCodexModelListResponse (CodexProvider.ts:229-239, 329-345) e o recorte do schema V2ModelListResponse__Model (packages/effect-codex-app-server/src/_generated/schema.gen.ts:30966-31016, 53684-53730) viraram zod + async sem Effect; o Nexus guarda só ids, `isDefault`, esforços por modelo e `upgrade` (sem capacidades de UI), descarta `hidden` mesmo se o servidor mandar, limita as páginas e recusa cursor repetido.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { resolveCliBinary } from '../path-resolver';
import { authBlobIsFreshForSpawn, waitForRotatingAuthSpawnGate } from './managed-auth-spawn-gate';
import { withCodexAppServer, type CodexAppServerRpc } from './codex-app-server-rpc';

/**
 * F-964 (PRV-03): a lista de modelos do Codex vem do `model/list` do
 * app-server (o que a CONTA do CODEX_HOME pode usar), não do
 * `models_cache.json` — que traz ids que não são de chat (`codex-auto-review`)
 * e não diz o que a conta enxerga. O cache fica como fallback.
 */

export const CODEX_MODEL_LIST_MAX_PAGES = 20;

const reasoningEffortOption = z.object({ reasoningEffort: z.string().min(1) });
const codexModelRow = z.object({
  model: z.string().min(1),
  displayName: z.string().optional(),
  hidden: z.boolean().optional(),
  isDefault: z.boolean().optional(),
  defaultReasoningEffort: z.string().optional(),
  supportedReasoningEfforts: z.array(reasoningEffortOption).optional(),
  upgrade: z.string().nullable().optional(),
});
const codexModelListPage = z.object({
  data: z.array(codexModelRow),
  nextCursor: z.string().nullable().optional(),
});
const accountRead = z.object({
  account: z.unknown().nullable().optional(),
  requiresOpenaiAuth: z.boolean().optional(),
});

export interface CodexModelListing {
  /** Ids visíveis, na ordem do app-server. */
  readonly ids: readonly string[];
  /** O que o próprio Codex marcou como default. */
  readonly defaultModel?: string;
  readonly effortsByModel: Readonly<Record<string, readonly string[]>>;
  /** Ids escondidos do seletor (`hidden: true`) — nunca oferecidos. */
  readonly hidden: readonly string[];
  /** `upgrade`: o modelo que o Codex sugere no lugar deste. */
  readonly upgrades: Readonly<Record<string, string>>;
}

/** Junta as páginas já validadas numa listagem. */
export function parseCodexModelListPages(pages: readonly unknown[]): CodexModelListing {
  const ids: string[] = [];
  const hidden: string[] = [];
  const effortsByModel: Record<string, string[]> = {};
  const upgrades: Record<string, string> = {};
  let defaultModel: string | undefined;
  for (const page of pages) {
    for (const row of codexModelListPage.parse(page).data) {
      const id = row.model.trim();
      if (!id) continue;
      if (row.hidden === true) {
        if (!hidden.includes(id)) hidden.push(id);
        continue;
      }
      if (ids.includes(id)) continue;
      ids.push(id);
      if (row.isDefault === true && defaultModel === undefined) defaultModel = id;
      effortsByModel[id] = [...new Set((row.supportedReasoningEfforts ?? []).map((option) => option.reasoningEffort))];
      if (row.upgrade) upgrades[id] = row.upgrade;
    }
  }
  return { ids, ...(defaultModel ? { defaultModel } : {}), effortsByModel, hidden, upgrades };
}

/** Pagina `model/list` até o fim (porte de requestAllCodexModels). */
export async function requestAllCodexModels(
  rpc: CodexAppServerRpc,
  options: { maxPages?: number } = {},
): Promise<CodexModelListing> {
  const maxPages = options.maxPages ?? CODEX_MODEL_LIST_MAX_PAGES;
  const pages: unknown[] = [];
  const seen = new Set<string>();
  let cursor: string | null | undefined;
  do {
    if (pages.length >= maxPages) throw new Error('model/list: páginas demais');
    const page = await rpc.request('model/list', cursor ? { cursor } : {});
    const parsed = codexModelListPage.parse(page);
    pages.push(parsed);
    cursor = parsed.nextCursor;
    if (cursor) {
      // Cursor repetido = servidor em laço; uma lista parcial não é a verdade.
      if (seen.has(cursor)) throw new Error('model/list: cursor repetido');
      seen.add(cursor);
    }
  } while (cursor);
  return parseCodexModelListPages(pages);
}

/** true quando a conta do CODEX_HOME exige login (sem conta e sem auth). */
export function codexAccountRequiresLogin(result: unknown): boolean {
  const parsed = accountRead.safeParse(result);
  return !parsed.success || (parsed.data.account == null && parsed.data.requiresOpenaiAuth === true);
}

/** CODEX_HOME do login nativo — o mesmo de onde vem o models_cache.json. */
export function nativeCodexHome(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.CODEX_HOME?.trim();
  return fromEnv && path.isAbsolute(fromEnv) ? fromEnv : path.join(os.homedir(), '.codex');
}

/**
 * Descoberta viva do Codex no CODEX_HOME nativo: o portão de renovação do
 * auth.json vem antes do spawn (só o próprio Codex renova o login, e só um
 * processo por vez). Sem auth.json não há conta para listar — nem abre.
 */
export async function discoverCodexModelsViaAppServer(options: {
  codexHome?: string;
  binary?: string;
  timeoutMs?: number;
} = {}): Promise<CodexModelListing> {
  const codexHome = options.codexHome ?? nativeCodexHome();
  const authFile = path.join(codexHome, 'auth.json');
  if (!fs.existsSync(authFile)) throw new Error('codex: sem login neste CODEX_HOME');
  const binary = options.binary ?? resolveCliBinary('codex')?.binPath;
  if (!binary) throw new Error('codex: CLI não instalada');
  await waitForRotatingAuthSpawnGate({ authFile });
  let current = '';
  try { current = fs.readFileSync(authFile, 'utf8'); } catch { /* ficou sem arquivo: o Codex decide */ }
  const refreshToken = current.length > 0 && !authBlobIsFreshForSpawn(current);
  return withCodexAppServer(
    { binary, codexHome, timeoutMs: options.timeoutMs ?? 15_000, clientName: 'nexus_models' },
    async (rpc) => {
      if (codexAccountRequiresLogin(await rpc.request('account/read', { refreshToken }))) {
        throw new Error('codex: login expirado');
      }
      return requestAllCodexModels(rpc);
    },
  );
}
