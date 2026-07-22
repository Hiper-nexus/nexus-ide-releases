import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { ipcMain } from 'electron';
import type { WebContents } from 'electron';
import {
  OMP_AUTH_CHANNELS,
  ompAuthLoginRequestSchema,
  type OmpAuthBrokerEntry,
  type OmpAuthCommandResult,
  type OmpAuthEventEnvelope,
  type OmpAuthListResult,
  type OmpAuthLoginResult,
  type OmpAuthProviderInfo,
  type OmpAuthPushEvent,
} from '../../shared/omp-auth-types';
import { OmpLoginFlow, parseAuthBrokerList } from './omp-auth';
import {
  closeOmpAuthWindow,
  disposeOmpAuthWindow,
  openOmpAuthWindow,
  OMP_AUTH_WINDOW_CLOSE_ON_DONE_DELAY_MS,
} from './omp-auth-window';
import { buildOmpChildEnv, resolveOmpBin } from './omp-rpc-service';

/**
 * IPC do domínio ompAuth: lista os provedores OAuth que o omp suporta
 * (`auth-broker list`), sonda quais já têm credencial no cofre do omp
 * (`omp token <id>` — avaliado SÓ por exit code, stdio ignorado: o segredo
 * nunca entra no heap do Nexus) e hospeda fluxos `auth-broker login` com push
 * de eventos estreitos ao renderer.
 *
 * Sem gate de orquestrador: é uma ação do usuário na própria UI (mesmo nível
 * de confiança do botão "Instalar omp" já existente no painel).
 */

const LIST_TIMEOUT_MS = 10_000;
const TOKEN_PROBE_CONCURRENCY = 6;

/** Assinaturas mais usadas primeiro; o resto depois, alfabético. */
const PREFERRED_PROVIDER_ORDER = [
  'anthropic',
  'openai-codex',
  'google-gemini-cli',
  'github-copilot',
  'zai',
  'kimi-code',
  'xai-oauth',
  'openrouter',
] as const;

interface HostedFlow {
  flowId: string;
  flow: OmpLoginFlow;
  /** URL OAuth do `awaiting-auth` — o main é a autoridade sobre ela. */
  authUrl?: string;
}

/** Um fluxo de login por renderer (single-flight). */
const activeFlows = new Map<WebContents, HostedFlow>();
const watchedOwners = new WeakSet<WebContents>();

type ExecFileFn = (
  file: string,
  args: string[],
  options: { timeout: number; env?: NodeJS.ProcessEnv },
  cb: (err: Error | null, stdout: string | Buffer) => void,
) => unknown;

function execText(
  execImpl: ExecFileFn,
  file: string,
  args: string[],
): Promise<string> {
  return new Promise((resolve, reject) => {
    execImpl(
      file,
      args,
      { timeout: LIST_TIMEOUT_MS, env: buildOmpChildEnv() },
      (err, stdout) => {
        if (err) reject(err);
        else resolve(String(stdout));
      },
    );
  });
}

/** `omp auth-broker list --json` → entradas validadas. */
async function listBrokerProviders(
  binPath: string,
  execImpl: ExecFileFn = execFile as unknown as ExecFileFn,
): Promise<OmpAuthBrokerEntry[]> {
  const stdout = await execText(execImpl, binPath, [
    'auth-broker',
    'list',
    '--json',
  ]);
  return parseAuthBrokerList(JSON.parse(stdout));
}

/**
 * Sonda `omp token <id>`: exit 0 = credencial no cofre do omp. stdio
 * totalmente ignorado — o stdout É o token e nunca pode tocar este processo
 * (nem heap, nem log).
 */
function probeToken(binPath: string, providerId: string): Promise<boolean> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(binPath, ['token', providerId], {
        stdio: 'ignore',
        env: buildOmpChildEnv(),
      });
    } catch {
      resolve(false);
      return;
    }
    child.on('error', () => resolve(false));
    child.on('exit', (code) => resolve(code === 0));
  });
}

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await fn(items[index]);
    }
  }
  const lanes = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: lanes }, () => worker()));
  return results;
}

function sortProviders(entries: OmpAuthBrokerEntry[]): OmpAuthBrokerEntry[] {
  const rank = (id: string): number => {
    const index = PREFERRED_PROVIDER_ORDER.indexOf(
      id as (typeof PREFERRED_PROVIDER_ORDER)[number],
    );
    return index === -1 ? PREFERRED_PROVIDER_ORDER.length : index;
  };
  return [...entries].sort((a, b) => {
    const byRank = rank(a.id) - rank(b.id);
    if (byRank !== 0) return byRank;
    return a.name.localeCompare(b.name, 'pt-BR');
  });
}

function toError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function watchOwner(owner: WebContents): void {
  if (watchedOwners.has(owner)) return;
  watchedOwners.add(owner);
  owner.once('destroyed', () => {
    const hosted = activeFlows.get(owner);
    if (hosted) {
      activeFlows.delete(owner);
      hosted.flow.cancel();
    }
  });
}

function finishFlow(owner: WebContents, hosted: HostedFlow): void {
  if (activeFlows.get(owner) === hosted) activeFlows.delete(owner);
}

async function listProviders(): Promise<OmpAuthListResult> {
  let binPath: string;
  try {
    binPath = (await resolveOmpBin()).binPath;
  } catch (err) {
    return { ok: false, providers: [], error: toError(err) };
  }
  let entries: OmpAuthBrokerEntry[];
  try {
    entries = await listBrokerProviders(binPath);
  } catch (err) {
    return {
      ok: false,
      providers: [],
      error: `falha ao listar provedores do omp: ${toError(err)}`,
    };
  }
  const connected = await mapLimit(
    entries,
    TOKEN_PROBE_CONCURRENCY,
    (entry) => probeToken(binPath, entry.id),
  );
  const connectedById = new Map(
    entries.map((entry, index) => [entry.id, connected[index] === true]),
  );
  const providers: OmpAuthProviderInfo[] = sortProviders(entries).map(
    (entry) => ({
      id: entry.id,
      name: entry.name,
      connected: connectedById.get(entry.id) === true,
    }),
  );
  return { ok: true, providers };
}

async function startLogin(
  owner: WebContents,
  raw: unknown,
): Promise<OmpAuthLoginResult> {
  const parsed = ompAuthLoginRequestSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: 'payload inválido' };
  if (activeFlows.has(owner)) {
    return { ok: false, error: 'já há um login em andamento neste painel' };
  }

  let binPath: string;
  try {
    binPath = (await resolveOmpBin()).binPath;
  } catch (err) {
    return { ok: false, error: toError(err) };
  }

  // Allowlist viva do próprio CLI: só ids que o auth-broker anuncia.
  let entries: OmpAuthBrokerEntry[];
  try {
    entries = await listBrokerProviders(binPath);
  } catch (err) {
    return { ok: false, error: `falha ao listar provedores do omp: ${toError(err)}` };
  }
  const providerId = parsed.data.providerId;
  if (!entries.some((entry) => entry.id === providerId)) {
    return { ok: false, error: `provedor desconhecido pelo omp: ${providerId}` };
  }

  const flowId = randomUUID();
  const hostedRef: { current: HostedFlow | null } = { current: null };
  const flow = new OmpLoginFlow(
    { flowId, providerId, binPath },
    {
      onEvent: (event: OmpAuthPushEvent) => {
        if (!owner.isDestroyed()) {
          const envelope: OmpAuthEventEnvelope = { flowId, event };
          owner.send(OMP_AUTH_CHANNELS.event, envelope);
        }
        if (event.phase === 'awaiting-auth') {
          // Abre a janela in-app assim que a URL existe (o botão do painel
          // vira só reabrir/focar). Ela fecha sozinha no done/error — a aba
          // de browser externa ficava pendurada para sempre.
          const hostedFlow = hostedRef.current;
          if (hostedFlow) hostedFlow.authUrl = event.url;
          openOmpAuthWindow(event.url);
          return;
        }
        if (event.phase === 'done' || event.phase === 'error') {
          closeOmpAuthWindow(
            event.phase === 'done' ? OMP_AUTH_WINDOW_CLOSE_ON_DONE_DELAY_MS : 0,
          );
          const hosted = hostedRef.current;
          if (hosted) finishFlow(owner, hosted);
        }
      },
    },
  );
  const hosted: HostedFlow = { flowId, flow };
  hostedRef.current = hosted;
  activeFlows.set(owner, hosted);
  watchOwner(owner);
  return { ok: true, flowId };
}

export function registerOmpAuthIpc(): void {
  ipcMain.handle(OMP_AUTH_CHANNELS.listProviders, (): Promise<OmpAuthListResult> =>
    listProviders(),
  );

  ipcMain.handle(
    OMP_AUTH_CHANNELS.login,
    (event, raw): Promise<OmpAuthLoginResult> => startLogin(event.sender, raw),
  );

  ipcMain.handle(OMP_AUTH_CHANNELS.cancelLogin, (event): OmpAuthCommandResult => {
    const hosted = activeFlows.get(event.sender);
    if (!hosted) return { ok: false, error: 'nenhum login em andamento' };
    activeFlows.delete(event.sender);
    hosted.flow.cancel();
    return { ok: true };
  });

  // Reabrir/focar a janela de autorização (ex.: usuário fechou sem querer).
  // A URL vem do fluxo hospedado no main — o renderer nunca injeta URL aqui.
  ipcMain.handle(OMP_AUTH_CHANNELS.openAuthWindow, (event): OmpAuthCommandResult => {
    const hosted = activeFlows.get(event.sender);
    if (!hosted?.authUrl) {
      return { ok: false, error: 'nenhuma autorização pendente neste painel' };
    }
    return openOmpAuthWindow(hosted.authUrl);
  });
}

/** Encerramento do app: mata qualquer fluxo de login pendurado. */
export function disposeAllOmpAuthFlows(): void {
  for (const [owner, hosted] of [...activeFlows.entries()]) {
    activeFlows.delete(owner);
    hosted.flow.cancel();
  }
  disposeOmpAuthWindow();
}
