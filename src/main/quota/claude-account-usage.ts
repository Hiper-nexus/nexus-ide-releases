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
import { ensureFreshClaudeSubscription, getAccount } from '../persistence/account-store';
import { getSecret } from '../persistence/secrets-store';
import {
  managedClaudeAuthHasCredential,
  managedClaudeAuthDirectory,
  materializeManagedClaudeAuth,
  readManagedClaudeAuth,
} from '../adapters/managed-claude-auth';
import { claudeCredentialBlobIsUsable } from '../adapters/claude-credential';
import {
  claudeBlobIsExpiredUnhealable,
  claudeBlobNeedsRefresh,
} from './claude-oauth-refresh';
import {
  cliFailureHint,
  extractClaudeAccessToken,
  managedClaudeCliEnv,
  probeClaudeCliUsage,
  probeClaudeOauthUsage,
  parseClaudeOauthUsage,
  type ClaudeCliRunImpl,
  type FetchLike,
} from './claude-oauth-usage';
import { probeClaudeCredentialIdentity } from './claude-native-account';
import { readNativeOAuthCredential } from '../adapters/native-oauth-keychain';
import type { QuotaReadHint } from '../../shared/quota-types';

const CRED_PREFIX = 'acctcred:';
const CLAUDE_KEYCHAIN_SERVICE = 'Claude Code-credentials';

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
  fetchImpl?: FetchLike;
  /** Test seam for the macOS scoped Keychain existence check. */
  keychainProbe?: (service: string) => boolean;
}

/** Resultado da cascata por conta: janelas ou o motivo honesto da ausência. */
export interface ClaudeAccountUsageResult {
  windows: QuotaWindow[] | null;
  hint?: QuotaReadHint;
}

async function readProfileCredential(
  profile: ClaudeProfileInfo,
  probe: (service: string) => boolean,
): Promise<{ credential: string | null; unavailable: boolean }> {
  if (process.platform === 'darwin') {
    const service = profile.slug === null
      ? CLAUDE_KEYCHAIN_SERVICE
      : claudeProfileKeychainService(profile.configDir);
    if (probe(service)) {
      try {
        const credential = await readNativeOAuthCredential(service, undefined, { bypassCache: true });
        return { credential, unavailable: credential === null };
      } catch {
        // The CLI would use this item. A file cannot stand in for a denied read.
        return { credential: null, unavailable: true };
      }
    }
  }
  try {
    const file = path.join(profile.configDir, '.credentials.json');
    if (fs.statSync(file).size > 1_000_000) return { credential: null, unavailable: true };
    return { credential: fs.readFileSync(file, 'utf8'), unavailable: false };
  } catch {
    return { credential: null, unavailable: false };
  }
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
  const ownedWindows = async (credential: string | null): Promise<ClaudeAccountUsageResult> => {
    const identity = await probeClaudeCredentialIdentity(
      credential, account.email, { now, fetchImpl: opts.fetchImpl },
    );
    if (identity !== 'match') {
      return { windows: null, hint: identity === 'mismatch' ? 'identity-mismatch' : identity };
    }
    const token = credential ? extractClaudeAccessToken(credential) : null;
    if (!token) return { windows: null, hint: 'auth-expired' };
    // The CLI can silently use a different Keychain entry from a stale file.
    // Only the usage returned for this proven token may enter the account row.
    const usage = await probeClaudeOauthUsage(token, { now, fetchImpl: opts.fetchImpl });
    return usage.windows?.length
      ? { windows: usage.windows }
      : { windows: null, hint: usage.failure ?? 'unavailable' };
  };
  const ownedScopedWindows = async (fallback: string | null = null): Promise<ClaudeAccountUsageResult> => {
    const directory = managedClaudeAuthDirectory(accountId, opts.home);
    const service = claudeProfileKeychainService(directory);
    if (process.platform === 'darwin' && (opts.keychainProbe ?? keychainItemExists)(service)) {
      // Claude chooses its scoped Keychain item over the private file. A valid
      // file cannot prove that the CLI will use the same account. Bypass the
      // short successful-read cache; a denied read remains backed off.
      try {
        const live = await readNativeOAuthCredential(service, undefined, { bypassCache: true });
        return live ? ownedWindows(live) : { windows: null, hint: 'unavailable' };
      } catch {
        return { windows: null, hint: 'unavailable' };
      }
    }
    const local = readManagedClaudeAuth(accountId) ?? fallback;
    return ownedWindows(local);
  };

  // 1) Auth gerenciada: `claude /usage` scoped. O CLI lê a credencial
  //    isolada, renova sozinho se preciso e é dono do item de keychain —
  //    nenhum prompt, nenhum toque no login nativo.
  // O diretório existir NÃO basta: um escopo vazio faz o `claude` cair na
  // credencial nativa e devolver o uso de OUTRA conta nesta linha — foi o que
  // pintou duas contas com o mesmo consumo. Sem credencial no escopo, a
  // cascata segue para as fontes ancoradas em identidade.
  if (managedClaudeAuthHasCredential(accountId, { home: opts.home })) {
    const directory = managedClaudeAuthDirectory(accountId, opts.home);
    const probe = await probeClaudeCliUsage({
      now,
      runImpl: opts.runImpl,
      env: managedClaudeCliEnv(directory),
    });
    // The CLI owns its refresh lock. Read its result without becoming a
    // second refresh actor, then obtain usage from that verified token.
    const owned = await ownedScopedWindows();
    if (owned.windows?.length || owned.hint === 'identity-mismatch') return owned;
    hint = owned.hint ?? cliFailureHint(probe.failure ?? 'unavailable');
    // A managed scope that failed must not fall through to a native profile
    // whose display metadata merely resembles this saved account.
    return { windows: null, hint: hint ?? 'unavailable' };
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
      const profileRead = await readProfileCredential(profile, opts.keychainProbe ?? keychainItemExists);
      const credential = profileRead.credential;
      const identity = profileRead.unavailable ? 'unavailable' : await probeClaudeCredentialIdentity(credential, email, {
        now,
        fetchImpl: opts.fetchImpl,
      });
      if (identity !== 'match') {
        hint = identity === 'mismatch' ? 'identity-mismatch' : identity;
      } else {
        const token = credential ? extractClaudeAccessToken(credential) : null;
        const live = token
          ? await probeClaudeOauthUsage(token, { now, fetchImpl: opts.fetchImpl })
          : { windows: null, failure: 'auth-expired' as const };
        if (live.windows?.length) return { windows: live.windows };
        hint = live.failure ?? 'unavailable';
        // A local utilization cache may be 30 minutes old. The fleet/Redline
        // snapshot cannot carry its observation timestamp, so publishing it as
        // a fresh provider read would misstate the age of the measurement.
      }
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
  let verifiedBlob = blob;
  let vaultIdentity = await probeClaudeCredentialIdentity(verifiedBlob, account.email, {
    now, fetchImpl: opts.fetchImpl,
  });
  if (vaultIdentity === 'auth-expired' && claudeBlobNeedsRefresh(blob, now)) {
    // The account store owns refresh coordination and excludes native token
    // lineage. Quota never rotates a refresh token independently.
    await ensureFreshClaudeSubscription(accountId, now);
    const refreshed = readVaultCredentialBlob(accountId);
    if (!refreshed || refreshed === blob || getAccount(accountId)?.email !== account.email) {
      return { windows: null, hint: 'unavailable' };
    }
    verifiedBlob = refreshed;
    vaultIdentity = await probeClaudeCredentialIdentity(verifiedBlob, account.email, {
      now, fetchImpl: opts.fetchImpl,
    });
  }
  if (vaultIdentity !== 'match') {
    return { windows: null, hint: vaultIdentity === 'mismatch' ? 'identity-mismatch' : vaultIdentity };
  }
  try {
    const prepared = materializeManagedClaudeAuth(accountId, verifiedBlob);
    const probe = await probeClaudeCliUsage({
      now,
      runImpl: opts.runImpl,
      env: managedClaudeCliEnv(prepared.directory),
    });
    const owned = await ownedScopedWindows(prepared.blob);
    if (owned.windows?.length || owned.hint === 'identity-mismatch') return owned;
    hint = owned.hint ?? hint ?? cliFailureHint(probe.failure ?? 'unavailable');
  } catch {
    // materialização falhou (id inválido, blob sem slice) → hint honesto
  }
  return { windows: null, hint: hint ?? 'unavailable' };
}
