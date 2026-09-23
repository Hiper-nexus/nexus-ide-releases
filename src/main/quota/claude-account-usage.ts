/**
 * Uso Claude por CONTA vault — port das fontes do Codenotch
 * (ClaudeProfile discovery + ClaudeUsageCLI + cache do próprio CLI em
 * `.claude.json`) para o dispatcher de quota do Nexus.
 *
 * Toda fonte é ancorada na identidade da própria conta, na ordem:
 *
 *  1. Auth gerenciada (`~/.nexus/managed-accounts/claude/<id>/auth`) —
 *     `claude /usage` com CLAUDE_SECURESTORAGE_CONFIG_DIR. O CLI mantém a
 *     credencial isolada viva (refresh próprio) e é dono do item de keychain
 *     com escopo: zero prompt, zero toque no login nativo.
 *  2. Perfil de disco com o MESMO e-mail da conta (`~/.claude` ou
 *     `~/.claude-<slug>`): cache `cachedUsageUtilization` que o próprio CLI
 *     escreve no `.claude.json` do perfil (fresco ≤30 min), senão `claude
 *     /usage` com CLAUDE_CONFIG_DIR daquele perfil — a sessão do perfil É a
 *     conta quando os e-mails casam.
 *  3. Conta que só existe no vault: materializa a auth isolada (mesmo
 *     diretório que o spawn de pane usa) e deixa o CLI migrar/renovar a
 *     credencial — self-healing a partir daí. Blob expirado e sem refresh
 *     token não gera diretório: null honesto.
 *
 * Uma linha de conta NUNCA recebe número de outra conta: sem match de
 * identidade e sem credencial própria, o resultado é null (a UI fica no
 * «Sem leitura» honesto).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import type { QuotaWindow } from '../../shared/quota-types';
import { knownWindow } from './quota-normalize';
import { getAccount } from '../persistence/account-store';
import { getSecret, setSecret } from '../persistence/secrets-store';
import {
  CLAUDE_MANAGED_AUTH_ENV,
  managedClaudeAuthHasCredential,
  managedClaudeAuthDirectory,
  materializeManagedClaudeAuth,
  readManagedClaudeAuth,
} from '../adapters/managed-claude-auth';
import { claudeCredentialBlobIsUsable } from '../adapters/claude-credential';
import {
  claudeBlobIsExpiredUnhealable,
  claudeBlobNeedsRefresh,
  refreshClaudeOauthBlobDetailed,
} from './claude-oauth-refresh';
import {
  cliFailureHint,
  extractClaudeAccessToken,
  probeClaudeCliUsage,
  probeClaudeOauthUsage,
  parseClaudeOauthUsage,
  type ClaudeCliRunImpl,
} from './claude-oauth-usage';
import { readClaudeDesktopUsage } from './claude-desktop-cache';
import type { QuotaReadHint } from '../../shared/quota-types';

const CRED_PREFIX = 'acctcred:';
const CLAUDE_KEYCHAIN_SERVICE = 'Claude Code-credentials';
const CLAUDE_CONFIG_DIR_ENV = 'CLAUDE_CONFIG_DIR';

/**
 * Frescor do `cachedUsageUtilization` que o próprio `claude` escreve em
 * `.claude.json` — mesma janela de 30 min que o Codenotch aplica ao cache do
 * Desktop. Fora dela a leitura cai para o CLI, que a reescreve de qualquer
 * forma.
 */
export const CLAUDE_USAGE_CACHE_FRESH_MS = 30 * 60 * 1000;

/** Arquivos que o Claude Code cria na primeira corrida contra um diretório. */
const PROFILE_MARKERS = [
  'sessions',
  'projects',
  'settings.json',
  'history.jsonl',
  '.claude.json',
];

/** `.claude.json` pode passar de dezenas de MB (histórico por projeto). */
const CONFIG_FILE_MAX_BYTES = 64 * 1024 * 1024;

export interface ClaudeProfileInfo {
  /** null = `~/.claude` (perfil default); o sufixo de `~/.claude-<slug>` senão. */
  slug: string | null;
  configDir: string;
  /**
   * O default guarda `.claude.json` AO LADO do diretório (`~/.claude.json`);
   * um perfil via CLAUDE_CONFIG_DIR guarda DENTRO (Codenotch ClaudeProfile).
   */
  accountFile: string;
}

interface ClaudeConfigSnapshot {
  email?: string;
  accountUuid?: string;
  usageAccountUuid?: string;
  organizationUuid?: string;
  usageFetchedAtMs?: number;
  usage?: unknown;
  /** `oauthAccount.organizationRateLimitTier` — 'default_claude_max_20x' etc. */
  rateLimitTier?: string;
  organizationType?: string;
  billingType?: string;
}

/**
 * `.claude.json` é grande e reescrito pelo CLI o tempo todo — decode gated
 * por mtime+size, exatamente como o AccountFileCache do Codenotch.
 */
const configSnapshotCache = new Map<
  string,
  { mtimeMs: number; size: number; snapshot: ClaudeConfigSnapshot | null }
>();

export function readClaudeConfigSnapshot(
  accountFile: string,
): ClaudeConfigSnapshot | null {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(accountFile);
  } catch {
    configSnapshotCache.delete(accountFile);
    return null;
  }
  if (stat.size > CONFIG_FILE_MAX_BYTES) return null;
  const held = configSnapshotCache.get(accountFile);
  if (held && held.mtimeMs === stat.mtimeMs && held.size === stat.size) {
    return held.snapshot;
  }
  let snapshot: ClaudeConfigSnapshot | null = null;
  try {
    const raw = JSON.parse(fs.readFileSync(accountFile, 'utf8')) as Record<
      string,
      unknown
    >;
    const account = raw?.oauthAccount as Record<string, unknown> | undefined;
    const cached = raw?.cachedUsageUtilization as
      | Record<string, unknown>
      | undefined;
    snapshot = {
      accountUuid: typeof account?.accountUuid === 'string' ? account.accountUuid : undefined,
      usageAccountUuid: typeof cached?.accountUuid === 'string' ? cached.accountUuid : undefined,
      email:
        typeof account?.emailAddress === 'string' && account.emailAddress
          ? account.emailAddress
          : undefined,
      organizationUuid:
        typeof account?.organizationUuid === 'string' &&
        account.organizationUuid
          ? account.organizationUuid
          : undefined,
      usageFetchedAtMs:
        typeof cached?.fetchedAtMs === 'number' &&
        Number.isFinite(cached.fetchedAtMs)
          ? cached.fetchedAtMs
          : undefined,
      usage: cached?.utilization,
      rateLimitTier:
        typeof account?.organizationRateLimitTier === 'string' &&
        account.organizationRateLimitTier
          ? account.organizationRateLimitTier
          : undefined,
      organizationType:
        typeof account?.organizationType === 'string' &&
        account.organizationType
          ? account.organizationType
          : undefined,
      billingType:
        typeof account?.billingType === 'string' && account.billingType
          ? account.billingType
          : undefined,
    };
  } catch {
    snapshot = null;
  }
  configSnapshotCache.set(accountFile, {
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    snapshot,
  });
  return snapshot;
}

/** Test seam — esvazia o cache gated por mtime entre fixtures. */
export function clearClaudeConfigSnapshotCache(): void {
  configSnapshotCache.clear();
}

/**
 * Serviço de keychain onde o CLI guarda o token do perfil: sufixo = 8
 * primeiros hex do SHA-256 do caminho do config dir (regra do Claude Code,
 * igual ao `managedClaudeKeychainService` para CLAUDE_SECURESTORAGE_CONFIG_DIR).
 */
export function claudeProfileKeychainService(configDir: string): string {
  const suffix = createHash('sha256')
    .update(path.resolve(configDir).normalize('NFC'))
    .digest('hex')
    .slice(0, 8);
  return `${CLAUDE_KEYCHAIN_SERVICE}-${suffix}`;
}

/**
 * O item existe? Só atributos (sem `-w`): metadados não passam pela ACL do
 * item, então enumerar não custa prompt por candidato — mesmo motivo do
 * `hasKeychainCredential` do Codenotch.
 */
function keychainItemExists(service: string): boolean {
  if (process.platform !== 'darwin') return false;
  try {
    const res = spawnSync(
      'security',
      ['find-generic-password', '-s', service],
      { stdio: ['ignore', 'ignore', 'ignore'], timeout: 3_000, killSignal: 'SIGKILL' },
    );
    return res.status === 0;
  } catch {
    return false;
  }
}

/**
 * O perfil tem credencial? Sem token o diretório não é uma conta — é o que
 * separa `~/.claude-work` de `~/.claude-mem` (plugin que escreve os mesmos
 * markers mas nunca teve login). O default passa sempre (o app sempre o leu).
 */
function profileHasCredential(configDir: string, slug: string | null): boolean {
  const services =
    slug === null
      ? [claudeProfileKeychainService(configDir), CLAUDE_KEYCHAIN_SERVICE]
      : [claudeProfileKeychainService(configDir)];
  if (services.some(keychainItemExists)) return true;
  try {
    return fs.statSync(path.join(configDir, '.credentials.json')).isFile();
  } catch {
    return false;
  }
}

/**
 * `~/.claude` seguido de cada `~/.claude-<slug>` que o Claude Code usou de
 * verdade (markers + credencial), slugs em ordem alfabética — a ordem nunca
 * troca entre leituras.
 */
export function discoverClaudeProfiles(
  home = os.homedir(),
): ClaudeProfileInfo[] {
  const defaultDir = path.join(home, '.claude');
  const profiles: ClaudeProfileInfo[] = [
    {
      slug: null,
      configDir: defaultDir,
      accountFile: path.join(home, '.claude.json'),
    },
  ];
  let names: string[] = [];
  try {
    names = fs.readdirSync(home);
  } catch {
    return profiles;
  }
  for (const name of names.sort()) {
    if (!name.startsWith('.claude-') || name.length <= '.claude-'.length) {
      continue;
    }
    const dir = path.join(home, name);
    try {
      if (!fs.statSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }
    if (
      !PROFILE_MARKERS.some((m) => {
        try {
          return fs.statSync(path.join(dir, m)).isFile() ||
            fs.statSync(path.join(dir, m)).isDirectory();
        } catch {
          return false;
        }
      })
    ) {
      continue;
    }
    const slug = name.slice('.claude-'.length);
    if (!profileHasCredential(dir, slug)) continue;
    profiles.push({
      slug,
      configDir: dir,
      accountFile: path.join(dir, '.claude.json'),
    });
  }
  return profiles;
}

/**
 * Parse do `cachedUsageUtilization.utilization` que o CLI grava em
 * `.claude.json` — o array `limits[]` já vem normalizado (`session`,
 * `weekly_all`, `weekly_scoped` com `scope.model.display_name`). Sem ele, cai
 * nos buckets crus (`five_hour`/`seven_day`), mesmo shape do endpoint OAuth.
 */
export function parseClaudeCachedUtilization(
  utilization: unknown,
  now = Date.now(),
): QuotaWindow[] {
  if (!utilization || typeof utilization !== 'object') return [];
  const root = utilization as Record<string, unknown>;
  const out: QuotaWindow[] = [];
  const seen = new Set<string>();

  const push = (
    kind: 'hours' | 'weekly',
    label: string,
    percent: unknown,
    resetsAt: unknown,
  ): void => {
    if (typeof percent !== 'number' || !Number.isFinite(percent)) return;
    const key = `${kind}:${label}`;
    if (seen.has(key)) return;
    seen.add(key);
    const ms = typeof resetsAt === 'string' ? Date.parse(resetsAt) : NaN;
    out.push(
      knownWindow({
        kind,
        label,
        usedRatio: Math.max(0, Math.min(1, percent / 100)),
        source: 'provider-api',
        confidence: 'medium',
        resetsAt: Number.isFinite(ms) ? ms : undefined,
        now,
      }),
    );
  };

  const limits = root.limits;
  if (Array.isArray(limits)) {
    for (const entry of limits) {
      if (!entry || typeof entry !== 'object') continue;
      const rec = entry as Record<string, unknown>;
      const scope = rec.scope as Record<string, unknown> | null | undefined;
      const model = scope?.model as Record<string, unknown> | null | undefined;
      const modelName =
        typeof model?.display_name === 'string' && model.display_name
          ? model.display_name
          : undefined;
      if (rec.kind === 'session') {
        push('hours', '5 Horas', rec.percent, rec.resets_at);
      } else if (rec.kind === 'weekly_all') {
        push('weekly', 'Semanal', rec.percent, rec.resets_at);
      } else if (rec.kind === 'weekly_scoped' && modelName) {
        push('weekly', `Semanal (${modelName})`, rec.percent, rec.resets_at);
      }
    }
    if (out.length > 0) return out;
  }
  return parseClaudeOauthUsage(root, now);
}

function readVaultCredentialBlob(accountId: string): string | null {
  try {
    const value = getSecret(CRED_PREFIX + accountId);
    return typeof value === 'string' && value.trim() ? value : null;
  } catch {
    return null;
  }
}

export interface FetchClaudeAccountUsageOptions {
  now?: number;
  home?: string;
  runImpl?: ClaudeCliRunImpl;
}

/** Resultado da cascata por conta: janelas ou o motivo honesto da ausência. */
export interface ClaudeAccountUsageResult {
  windows: QuotaWindow[] | null;
  hint?: QuotaReadHint;
}

/** Secure storage alone does not isolate the CLI's cached usage in its config. */
function accountUsageEnv(directory: string): Record<string, string> {
  return {
    [CLAUDE_MANAGED_AUTH_ENV]: directory,
    [CLAUDE_CONFIG_DIR_ENV]: path.join(path.dirname(directory), 'quota'),
  };
}

/**
 * Cota desta conta pelo mesmo endpoint da linha nativa, usando SÓ o token
 * dela. No Windows o `claude /usage` isolado falha e as contas A e B ficavam
 * sem número. Nunca chama a sessão nativa.
 */
async function usageFromOwnClaudeToken(
  blob: string,
  now: number,
): Promise<ClaudeAccountUsageResult | null> {
  const token = extractClaudeAccessToken(blob);
  if (!token) return null;
  const probe = await probeClaudeOauthUsage(token, { now });
  if (probe.windows?.length) return { windows: probe.windows };
  if (probe.failure === 'auth-expired') return { windows: null, hint: 'auth-expired' };
  return null;
}

function persistVaultBlob(accountId: string, blob: string): void {
  try {
    setSecret(CRED_PREFIX + accountId, blob);
  } catch {
    // vault indisponível — o escopo materializado já recebeu o blob
  }
}

/**
 * A sonda CLI falhou mas a credencial da conta tem refreshToken: tenta a
 * renovação nós mesmos. `refreshed` grava no escopo gerenciado (mesma
 * linhagem que o CLI consome) e no vault, e retorna true para o chamador
 * repetir a sonda. `invalid-grant` = grant morto no provider — re-login.
 * Nunca roda na linhagem do login nativo (a CLI é dona dela).
 */
async function healScopedCredential(
  accountId: string,
  blob: string,
  now: number,
): Promise<{ status: 'refreshed' | 'invalid-grant' | 'error'; blob?: string }> {
  if (!claudeBlobNeedsRefresh(blob, now)) return { status: 'error' };
  const result = await refreshClaudeOauthBlobDetailed(blob, now);
  if (result.outcome !== 'refreshed' || !result.blob) return { status: result.outcome };
  try {
    materializeManagedClaudeAuth(accountId, result.blob);
    persistVaultBlob(accountId, result.blob);
    return { status: 'refreshed', blob: result.blob };
  } catch {
    return { status: 'error' };
  }
}

/**
 * Depois de renovar, a cota vem do token novo no mesmo endpoint do Mac.
 * `claude /usage` no Windows segue sem número mesmo com o token fresco.
 */
async function windowsAfterCredentialHeal(
  accountId: string,
  blob: string,
  now: number,
  directory: string | undefined,
  runImpl: ClaudeCliRunImpl | undefined,
): Promise<ClaudeAccountUsageResult | null> {
  const healed = await healScopedCredential(accountId, blob, now);
  if (healed.status === 'invalid-grant') return { windows: null, hint: 'auth-expired' };
  if (healed.status !== 'refreshed' || !healed.blob) return null;
  const own = await usageFromOwnClaudeToken(healed.blob, now);
  if (own?.windows?.length) return own;
  if (!directory) return null;
  const retry = await probeClaudeCliUsage({
    now,
    runImpl,
    env: accountUsageEnv(directory),
  });
  if (retry.windows?.length) return { windows: retry.windows };
  return { windows: null, hint: cliFailureHint(retry.failure ?? 'unavailable') };
}

/**
 * Janelas de uso para UMA conta Claude vault. `windows: null` = sem fonte
 * ancorada nesta conta — nunca empresta a leitura de outra; `hint` diz por
 * quê (sessão morta, sem credencial, CLI ausente, provider sem dados).
 */
export async function fetchClaudeAccountUsageWindows(
  accountId: string,
  opts: FetchClaudeAccountUsageOptions = {},
): Promise<ClaudeAccountUsageResult> {
  const now = opts.now ?? Date.now();
  const account = getAccount(accountId);
  if (!account || account.adapterId !== 'claude') {
    return { windows: null, hint: 'no-credential' };
  }
  let hint: QuotaReadHint | undefined;

  // 1) Auth gerenciada: `claude /usage` scoped. O CLI lê a credencial
  //    isolada, renova sozinho se preciso e é dono do item de keychain —
  //    nenhum prompt, nenhum toque no login nativo.
  // O diretório existir NÃO basta: um escopo vazio faz o `claude` cair na
  // credencial nativa e devolver o uso de OUTRA conta nesta linha — foi o que
  // pintou duas contas com o mesmo consumo. Sem credencial no escopo, a
  // cascata segue para as fontes ancoradas em identidade.
  if (managedClaudeAuthHasCredential(accountId, { home: opts.home })) {
    const managedBlob = readManagedClaudeAuth(accountId);
    if (managedBlob && claudeCredentialBlobIsUsable(managedBlob)) {
      if (claudeBlobNeedsRefresh(managedBlob, now)) {
        const healed = await windowsAfterCredentialHeal(
          accountId,
          managedBlob,
          now,
          managedClaudeAuthDirectory(accountId, opts.home),
          opts.runImpl,
        );
        if (healed?.windows?.length || healed?.hint === 'auth-expired') return healed;
        if (healed?.hint) hint = healed.hint;
      } else {
        const own = await usageFromOwnClaudeToken(managedBlob, now);
        if (own?.windows?.length) return own;
        if (own?.hint === 'auth-expired') return own;
      }
    }
    const directory = managedClaudeAuthDirectory(accountId, opts.home);
    const probe = await probeClaudeCliUsage({
      now,
      runImpl: opts.runImpl,
      env: accountUsageEnv(directory),
    });
    if (probe.windows?.length) return { windows: probe.windows };
    hint = cliFailureHint(probe.failure ?? 'unavailable');
    // A sonda falhou: se a credencial isolada está só vencida (refresh
    // possível), renovamos e tentamos de novo; grant revogado vira
    // auth-expired explícito em vez de «unavailable» mudo.
    if (probe.failure === 'unavailable' || probe.failure === 'auth-expired') {
      const managed = readManagedClaudeAuth(accountId);
      if (managed && claudeBlobNeedsRefresh(managed, now)) {
        const healed = await windowsAfterCredentialHeal(
          accountId,
          managed,
          now,
          directory,
          opts.runImpl,
        );
        if (healed?.windows?.length || healed?.hint === 'auth-expired') return healed;
        if (healed?.hint) hint = healed.hint;
      }
    }
  }

  // 2) Perfil de disco com o MESMO e-mail da conta. A sessão daquele perfil
  //    É esta conta — fontes do perfil são autoritativas para ela.
  const email = account.email?.trim().toLowerCase();
  if (email) {
    const profile = discoverClaudeProfiles(opts.home).find((p) => {
      const snap = readClaudeConfigSnapshot(p.accountFile);
      return snap?.email?.trim().toLowerCase() === email;
    });
    if (profile) {
      const snap = readClaudeConfigSnapshot(profile.accountFile);
      if (
        snap?.usage !== undefined &&
        Boolean(snap.accountUuid) &&
        snap.accountUuid === snap.usageAccountUuid &&
        typeof snap.usageFetchedAtMs === 'number' &&
        now >= snap.usageFetchedAtMs &&
        now - snap.usageFetchedAtMs <= CLAUDE_USAGE_CACHE_FRESH_MS
      ) {
        const windows = parseClaudeCachedUtilization(snap.usage, now);
        if (windows.length > 0) return { windows };
      }
      // Fonte Codenotch extra: cache HTTP do Claude Desktop. A org da conta
      // casa com o key do entry — a resposta que o app gravou vale mesmo com
      // a credencial do CLI morta, e é leitura de disco (sem spawn).
      if (snap?.organizationUuid) {
        const desktop = readClaudeDesktopUsage(snap.organizationUuid, { now });
        if (desktop) return { windows: desktop.windows };
      }
      const probe = await probeClaudeCliUsage({
        now,
        runImpl: opts.runImpl,
        env: profile.slug
          ? { [CLAUDE_CONFIG_DIR_ENV]: profile.configDir }
          : undefined,
      });
      if (probe.windows?.length) return { windows: probe.windows };
      // Falha de auth do perfil casado vale mais que um «unavailable» vago.
      if (probe.failure === 'auth-expired') hint = 'auth-expired';
      else if (hint === undefined) hint = cliFailureHint(probe.failure ?? 'unavailable');
    }
  }

  // 3) Blob vault da própria conta (mesma identidade — mesmo sem perfil no
  //    disco, ou quando o perfil casado falhou): materializa a auth isolada
  //    (o mesmo diretório que o spawn de pane usa). O CLI migra a credencial
  //    para o keychain com escopo — do qual ele é dono — e passa a renová-la.
  //    Blob morto sem refresh token: hint de sessão expirada, sem diretório
  //    órfão.
  const blob = readVaultCredentialBlob(accountId);
  if (!blob) {
    return {
      windows: null,
      // Diretório vazio é conta SEM credencial, não fonte indisponível: o
      // usuário precisa ver «entre novamente», não «tente mais tarde».
      hint:
        hint ??
        (managedClaudeAuthHasCredential(accountId, { home: opts.home })
          ? 'unavailable'
          : 'no-credential'),
    };
  }
  if (!claudeCredentialBlobIsUsable(blob) || claudeBlobIsExpiredUnhealable(blob, now)) {
    // Grant morto na origem: não há o que tentar — é re-login mesmo.
    return { windows: null, hint: 'auth-expired' };
  }
  const own = await usageFromOwnClaudeToken(blob, now);
  if (own?.windows?.length) return own;
  if (own?.hint === 'auth-expired' && !claudeBlobNeedsRefresh(blob, now)) {
    return own;
  }
  try {
    const prepared = materializeManagedClaudeAuth(accountId, blob);
    const probe = await probeClaudeCliUsage({
      now,
      runImpl: opts.runImpl,
      env: accountUsageEnv(prepared.directory),
    });
    if (probe.windows?.length) return { windows: probe.windows };
    if (probe.failure === 'auth-expired') hint = 'auth-expired';
    else if (hint === undefined) hint = cliFailureHint(probe.failure ?? 'unavailable');
    // Mesma cura do passo 1: blob vencido com refreshToken — renovamos,
    // gravamos nos dois lados e repetimos a sonda.
    if (probe.failure === 'unavailable' || probe.failure === 'auth-expired') {
      const healed = await windowsAfterCredentialHeal(
        accountId,
        blob,
        now,
        prepared.directory,
        opts.runImpl,
      );
      if (healed?.windows?.length || healed?.hint === 'auth-expired') return healed;
      if (healed?.hint) hint = healed.hint;
    }
  } catch {
    // materialização falhou (id inválido, blob sem slice) → hint honesto
  }
  return { windows: null, hint: hint ?? 'unavailable' };
}
