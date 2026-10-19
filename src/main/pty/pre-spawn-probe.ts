import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getAdapter } from '../adapters/adapter-registry';
import {
  claudeCredentialBlobIsUsable,
  readActiveClaudeCredential,
} from '../adapters/claude-credential';
import { isFileAuthAdapter } from '../../shared/file-auth-adapters';
import {
  claudeCliAuthStatusLoggedInSync,
  claudeOauthEmail,
  hasSubscriptionAuth,
  MUSE_KEYCHAIN_SERVICE,
  type AuthStrategy,
} from '../adapters/subscription-auth';
import { trace } from '../observability/main-trace';
import { isCredentiallessOpenCodeModel } from '../adapters/model-auth-readiness';
import { refreshKimiSeatReadiness } from '../adapters/kimi-seat-probe';
import {
  canSeat,
  classifySeatAuth,
  peekKimiSeatReadiness,
  seatFailureHint,
  type SeatAuthReadiness,
} from '../adapters/seat-auth-readiness';
import { listAccounts } from '../persistence/account-store';
import {
  hasRuntimeKey,
  providerAuthStrategy,
  providerAuthStrategyAuthoritativeAsync,
} from '../persistence/provider-config-store';

/**
 * Pre-spawn credential probe (peer ADE v1.2 harvest, fix F-256): a spawn
 * issued with a missing credential used to surface as a dead pane or a mute
 * login TUI. This probe runs BEFORE the pane exists — every check is a
 * stat/keychain read or a cached binary lookup, no network — and turns that
 * blind spawn into a typed, actionable error.
 *
 * EXCEÇÃO: o assento do Kimi prova credencial com uma execução real
 * (`kimi provider list --json`, ~0,5 s, teto de 4 s) porque a prova dele não
 * mora em arquivo. É pago só quando o CLI pedido é o kimi.
 *
 * Deliberate limits:
 *  - It is a light PRECHECK, not a duplicate of prepareAccountForSpawn: when
 *    the pane will pin a Nexus-managed account, that path already fails well
 *    (missing blob / expired cooldown / no API credential) and stays in
 *    charge. The probe only judges adapters with NO managed accounts.
 *  - What it cannot prove it does not judge: no configured probe for an
 *    adapter → pass. A probe internal failure blocks only an explicit
 *    Hardened spawn; direct terminals and the default autopilot let the CLI
 *    use its own live HOME/auth path. Runtime-broken credentials that still
 *    LOOK present are the login-stuck watchdog's job
 *    (orch/login-stuck-watchdog.ts), not this module's.
 */

export type PreSpawnProbeCode =
  | 'missing-credential'
  | 'binary-missing'
  | 'key-missing'
  | 'probe-unavailable';

export interface PreSpawnProbeFailure {
  code: PreSpawnProbeCode;
  adapterId: string;
  /** Actionable next step: where to log in / install / paste the key. */
  hint: string;
}

/** Typed error so orchestration callers can branch on `code` programmatically. */
export class PreSpawnProbeError extends Error {
  readonly code: PreSpawnProbeCode;
  readonly adapterId: string;
  readonly hint: string;

  constructor(failure: PreSpawnProbeFailure) {
    super(`[${failure.code}] ${failure.adapterId}: ${failure.hint}`);
    this.name = 'PreSpawnProbeError';
    this.code = failure.code;
    this.adapterId = failure.adapterId;
    this.hint = failure.hint;
  }
}

/** Minimal adapter view the probe needs (structural — Adapter satisfies it). */
export interface ProbeAdapterView {
  kind: string;
  auth?: { method?: string; loginHint?: string };
  models?: { default?: string };
}

export interface PreSpawnProbeDeps {
  getAdapter(adapterId: string): ProbeAdapterView | null;
  listAccounts(adapterId: string): readonly unknown[];
  hasStoredKey(adapterId: string, model?: string): boolean;
  readActiveClaudeCredential(): string | null;
  readClaudeCredentialsFile(): string | null;
  claudeOauthEmail(): string | null;
  /**
   * Live CLI attestation (`claude auth status`). Covers Keychain-only
   * sessions the spawn host cannot read (packaged-app TCC/ACL denial) —
   * a positive is a usable session, stronger than email identity.
   */
  claudeCliLoggedIn?: () => boolean;
  /** A mesma prontidão nativa usada pela UI e pela decisão de rota. */
  nativeSessionReady(adapterId: string, model?: string): boolean;
  authStrategy(adapterId: string, model?: string): AuthStrategy;
  /** Optional uncached authority used only at autonomous process creation. */
  authoritativeAuthStrategy?(
    adapterId: string,
    model?: string,
  ): AuthStrategy | Promise<AuthStrategy>;
  /**
   * Kimi `provider list` readiness. A produção liga a sonda VIVA aqui; testes
   * injetam um veredito fixo. Ausente, o probe cai na cache de processo — que
   * pode nunca ter sido aquecida, e é justamente aí que o assento se perde.
   */
  kimiSeatReadiness?(
    adapterId: string,
  ): SeatAuthReadiness | undefined | Promise<SeatAuthReadiness | undefined>;
}

export interface PreSpawnProbeOptions {
  /** Exact model selected for this spawn; absent means the adapter default. */
  readonly model?: string;
  /**
   * Explicit Hardened spawns cannot treat an unavailable readiness proof as
   * permission. Autopilot/direct terminals retain the unjudged fallback.
   */
  readonly failClosed?: boolean;
  /**
   * Autopilot remint / first-wave seating. Suppresses the civilian
   * "Cole sua API key" toast; LongCat / login-needed stay no-credential.
   */
  readonly silentRemint?: boolean;
  /**
   * True only when the operator explicitly picked this adapter (settings /
   * pane spawn). Toast "Cole sua API key" is allowed in that case.
   */
  readonly explicitCivilianPick?: boolean;
  /** Test seam; production callers must leave this unset. */
  readonly deps?: PreSpawnProbeDeps;
}

/**
 * Linux/headless Claude fallback (~/.claude/.credentials.json), mirroring the
 * bar activeClaudeAuthEnv applies (account-store.ts): the file must carry a
 * usable OAuth access token, not merely exist.
 */
function readClaudeCredentialsFile(): string | null {
  try {
    const raw = fs.readFileSync(
      path.join(os.homedir(), '.claude', '.credentials.json'),
      'utf8',
    );
    const parsed = JSON.parse(raw) as {
      claudeAiOauth?: { accessToken?: unknown };
    };
    const token = parsed.claudeAiOauth?.accessToken;
    return typeof token === 'string' && token.length > 0 ? raw : null;
  } catch {
    return null;
  }
}

/**
 * Fiação de produção do gate pré-spawn. Exportada para o teste de regressão
 * conseguir fixar a entrada do Kimi: `kimiSeatReadiness` ficou de fora por ser
 * rotulada "test seam", e sem ela o spawn lia SÓ a cache de processo — que é
 * aquecida em Settings/Contas, kickoff e bootstrap, nunca no spawn direto do
 * operador. Cache fria (ou corrida com o fold do PATH no boot) virava
 * "incomplete" → `missing-credential` → assento remapeado para claude sem
 * ninguém saber (campo 10/09: "pedi kimi, abriu sonnet").
 */
export const PRODUCTION_PROBE_DEPS: PreSpawnProbeDeps = {
  getAdapter: (adapterId) => getAdapter(adapterId),
  listAccounts: (adapterId) => listAccounts(adapterId),
  hasStoredKey: (adapterId, model) => hasRuntimeKey(adapterId, model),
  readActiveClaudeCredential,
  readClaudeCredentialsFile,
  claudeOauthEmail: () => claudeOauthEmail(),
  claudeCliLoggedIn: () => claudeCliAuthStatusLoggedInSync(),
  nativeSessionReady: hasSubscriptionAuth,
  authStrategy: (adapterId, model) =>
    providerAuthStrategy(adapterId, model),
  authoritativeAuthStrategy: (adapterId, model) =>
    providerAuthStrategyAuthoritativeAsync(adapterId, model),
  // Sonda VIVA: ~0,5s, só quando o assento pedido é o kimi, e o resultado vivo
  // sempre sobrepõe a cache (mergeKimiProviderListReadiness devolve o live).
  kimiSeatReadiness: () => refreshKimiSeatReadiness(),
};

function hintFor(adapter: ProbeAdapterView, fallback: string): string {
  return adapter.auth?.loginHint ?? fallback;
}

function claudeBlobLooksUsable(blob: string): boolean {
  // Prefer structured OAuth parse; bare non-empty strings (legacy tests /
  // synthetic deps) still count when JSON is absent.
  if (claudeCredentialBlobIsUsable(blob)) return true;
  try {
    JSON.parse(blob);
    return false;
  } catch {
    return blob.trim().length > 0;
  }
}

async function probe(
  adapterId: string,
  selectedModel: string | undefined,
  deps: PreSpawnProbeDeps,
  failClosed = false,
  options: Pick<PreSpawnProbeOptions, 'silentRemint' | 'explicitCivilianPick'> = {},
): Promise<PreSpawnProbeFailure | null> {
  const adapter = deps.getAdapter(adapterId);
  // Unknown adapters are rejected by the spawn gate itself — not ours to judge.
  if (!adapter) return null;

  const effectiveModel =
    selectedModel?.trim() || adapter.models?.default?.trim();
  const credentiallessOpenCode = isCredentiallessOpenCodeModel(
    adapterId,
    effectiveModel,
  );
  const managedAccountAvailable = deps.listAccounts(adapterId).length > 0;
  const authStrategyResolver =
    adapterId === 'agy' && deps.authoritativeAuthStrategy
      ? deps.authoritativeAuthStrategy
      : deps.authStrategy;
  const currentAuthStrategy = await authStrategyResolver(
    adapterId,
    effectiveModel,
  );

  // AGY's Keychain-only login needs a live check because a user can complete
  // OAuth while the renderer's 60s status cache still says login-needed.
  // The authority probe is asynchronous so a locked Keychain cannot freeze
  // Electron's main loop. Other adapters retain their dedicated probes below.
  if (
    currentAuthStrategy === 'login-needed' &&
    !credentiallessOpenCode
  ) {
    const civilianHint = hintFor(
      adapter,
      'faça login no CLI ou adicione a conta em Configurações › Contas de IA',
    );
    return {
      code: 'missing-credential',
      adapterId,
      hint: seatFailureHint({
        readiness: 'no-credential',
        explicitCivilianPick:
          options.explicitCivilianPick === true ||
          options.silentRemint !== true,
        civilianHint,
      }),
    };
  }

  // A Nexus-managed account means the pinned-account path will validate the
  // credential (prepareAccountForSpawn already fails those cases well).
  if (managedAccountAvailable) return null;

  // AGY 1.1 stores its OAuth session in the native macOS Keychain and does not
  // create a capturable oauth_creds.json. The authoritative provider decision
  // above probes that exact Keychain source. Requiring a file after it succeeds
  // turns a healthy AGY login into a permanent missing-credential loop.
  if (adapterId === 'agy' && currentAuthStrategy === 'subscription') {
    return null;
  }

  if (adapterId === 'claude') {
    // Usable session only: non-empty OAuth access token in keychain blob or
    // credentials file, or a stored API key. oauthAccount email alone is
    // identity, not a live session — it survives OAuth expiry and used to
    // open mute Maestro panes on isolated HOME.
    const keychainBlob = deps.readActiveClaudeCredential();
    if (
      typeof keychainBlob === 'string' &&
      keychainBlob.length > 0 &&
      claudeBlobLooksUsable(keychainBlob)
    ) {
      return null;
    }
    if (deps.readClaudeCredentialsFile() !== null) return null;
    if (deps.hasStoredKey(adapterId, effectiveModel)) return null;
    // Live CLI attestation outranks storage reads: a Keychain-only session
    // unreadable from this host (TCC/ACL) still spawns fine, since the CLI
    // reads its own storage. Trusted in failClosed too — the CLI proves a
    // usable session, unlike email identity below.
    if (deps.claudeCliLoggedIn?.() === true) return null;
    // Governed / fail-closed spawns (mission, isolated HOME) never trust email.
    // Direct user terminals may still open when we only know the identity and
    // the CLI will use native keychain itself (non-isolated HOME).
    if (!failClosed && deps.claudeOauthEmail() !== null) {
      return null;
    }
    return {
      code: 'missing-credential',
      adapterId,
      hint: hintFor(
        adapter,
        'rode `claude auth login` num terminal para autenticar, ou adicione a conta em Configurações › Contas de IA',
      ),
    };
  }

  // File-backed subscription CLIs: a sessão nativa (arquivo ou Keychain) usa
  // a MESMA prontidão da UI/rota; conta gerenciada já foi coberta acima.
  if (isFileAuthAdapter(adapterId)) {
    if (adapterId === 'kimi') {
      const listed =
        (await deps.kimiSeatReadiness?.(adapterId)) ?? peekKimiSeatReadiness();
      const readiness = classifySeatAuth({
        adapterId: 'kimi',
        authStrategy: currentAuthStrategy,
        hasKey: deps.hasStoredKey(adapterId, effectiveModel),
        kimiListReadiness: listed,
      });
      if (canSeat(readiness)) return null;
      const civilianHint = hintFor(
        adapter,
        'rode `kimi login` ou confirme `kimi provider list` com source=oauth',
      );
      return {
        code: 'missing-credential',
        adapterId,
        hint: seatFailureHint({
          readiness,
          explicitCivilianPick:
            options.explicitCivilianPick === true ||
            options.silentRemint !== true,
          civilianHint,
        }),
      };
    }
    // OpenCode's own pinned free catalog is usable without provider auth.
    // The exact model matters: external OpenRouter routes and unreviewed
    // `opencode/*-free` lookalikes must still fail before a pane exists.
    if (credentiallessOpenCode) return null;
    if (adapterId === 'mimo-code' && currentAuthStrategy === 'subscription') return null;
    if (deps.nativeSessionReady(adapterId, effectiveModel)) return null;
    if (deps.hasStoredKey(adapterId, effectiveModel)) return null;
    return {
      code: 'missing-credential',
      adapterId,
      hint: hintFor(
        adapter,
        'faça login no CLI ou adicione a conta em Configurações › Contas de IA',
      ),
    };
  }

  // Pure API-key routes (glm/longcat/aider) and future api-provider adapters:
  // the key is the only credential there is.
  const authMethod =
    adapter.kind === 'cli-pty' ? adapter.auth?.method : 'api_key';
  if (authMethod === 'api_key') {
    if (deps.hasStoredKey(adapterId, effectiveModel)) return null;
    const civilianHint = hintFor(
      adapter,
      'cole a API key em Configurações › Contas de IA',
    );
    const silentRemint =
      options.silentRemint === true && options.explicitCivilianPick !== true;
    if (silentRemint) {
      return {
        code: 'missing-credential',
        adapterId,
        hint: seatFailureHint({
          readiness: 'no-credential',
          explicitCivilianPick: false,
          civilianHint,
        }),
      };
    }
    return {
      code: 'key-missing',
      adapterId,
      hint: civilianHint,
    };
  }

  // subscription / device_code / none without a dedicated probe → unjudged.
  return null;
}

/**
 * Rota ≠ execução (campo 16/10): a rota lia o `muse` como pronto
 * (`authStrategy` sem `login-needed`), o gate daqui recusava a credencial
 * delegada ao Keychain e o assento caía calado no `claude` — 22 de 23 spawns,
 * porque nada lembrava a recusa e o fair-share via o muse com "0 uso". O
 * spawn que remapeia o assento anota a recusa aqui; a rota tira a CLI enquanto
 * ela vale. Uma recusa expira em 10 min; duas em 1 h ficam até um probe passar.
 * Memória do processo: partida fria = nenhuma recusa. O primeiro probe que
 * passa para a CLI apaga a anotação (login refeito volta na hora).
 */
const RECENT_CREDENTIAL_FAILURE_TTL_MS = 10 * 60_000;
const REPEATED_CREDENTIAL_FAILURE_WINDOW_MS = 60 * 60_000;
interface CredentialFailureHistory {
  failures: number[];
  repeated: boolean;
}
const recentCredentialFailures = new Map<string, CredentialFailureHistory>();

function credentialFailureHistory(
  adapterId: string,
  now: number,
): CredentialFailureHistory | undefined {
  const history = recentCredentialFailures.get(adapterId);
  if (!history) return undefined;
  history.failures = history.failures.filter(
    (at) => now - at < REPEATED_CREDENTIAL_FAILURE_WINDOW_MS,
  );
  if (history.failures.length === 0 && !history.repeated) {
    recentCredentialFailures.delete(adapterId);
    return undefined;
  }
  return history;
}

export function recordRecentCredentialProbeFailure(
  adapterId: string,
  now = Date.now(),
): void {
  const history = recentCredentialFailures.get(adapterId) ?? {
    failures: [],
    repeated: false,
  };
  history.failures.push(now);
  history.failures = history.failures.filter(
    (at) => now - at < REPEATED_CREDENTIAL_FAILURE_WINDOW_MS,
  );
  if (history.failures.length >= 2) history.repeated = true;
  recentCredentialFailures.set(adapterId, history);
}

export function hasRepeatedCredentialProbeFailure(
  adapterId: string,
  now = Date.now(),
): boolean {
  return credentialFailureHistory(adapterId, now)?.repeated === true;
}

export function hasRecentCredentialProbeFailure(
  adapterId: string,
  now = Date.now(),
): boolean {
  const history = credentialFailureHistory(adapterId, now);
  if (!history) return false;
  if (history.repeated) return true;
  const latest = history.failures.at(-1);
  if (latest !== undefined && now - latest < RECENT_CREDENTIAL_FAILURE_TTL_MS) {
    return true;
  }
  // Fora dos 10 min, mas o histórico fica para a janela de 1 h: apagar aqui
  // fazia a 2ª recusa contar como 1ª e `repeated` nunca ligava na rota.
  return false;
}

/**
 * A sonda de recuperação de uma CLI com recusa repetida roda no máximo uma vez
 * a cada {@link RECENT_CREDENTIAL_FAILURE_TTL_MS}: sem isso cada rota sondava
 * de novo (auth status / Keychain no Main).
 */
const credentialRecoveryProbedAt = new Map<string, number>();

export function claimCredentialRecoveryProbe(
  adapterId: string,
  now = Date.now(),
): boolean {
  const last = credentialRecoveryProbedAt.get(adapterId);
  if (last !== undefined && now - last < RECENT_CREDENTIAL_FAILURE_TTL_MS) return false;
  credentialRecoveryProbedAt.set(adapterId, now);
  return true;
}

/** Divergência probe × UI: no máximo uma checagem por CLI a cada 10 min. */
const divergenceCheckedAt = new Map<string, number>();

export function clearRecentCredentialProbeFailuresForTests(): void {
  recentCredentialFailures.clear();
  credentialRecoveryProbedAt.clear();
  divergenceCheckedAt.clear();
}

/**
 * Run the pre-spawn probe. `null` means "spawn may proceed" — either because
 * a credential was found or because the adapter is not judgeable here.
 */
export async function probePreSpawn(
  adapterId: string,
  options: PreSpawnProbeOptions = {},
): Promise<PreSpawnProbeFailure | null> {
  try {
    const deps = options.deps ?? PRODUCTION_PROBE_DEPS;
    const failure = await probe(
      adapterId,
      options.model,
      deps,
      options.failClosed === true,
      options,
    );
    const now = Date.now();
    const lastDivergenceCheck = divergenceCheckedAt.get(adapterId);
    if (
      failure &&
      (failure.code === 'missing-credential' || failure.code === 'key-missing') &&
      // Kimi decide pelo `kimi provider list`, como a UI: não é divergência.
      adapterId !== 'kimi' &&
      (lastDivergenceCheck === undefined ||
        now - lastDivergenceCheck >= RECENT_CREDENTIAL_FAILURE_TTL_MS)
    ) {
      divergenceCheckedAt.set(adapterId, now);
      let uiShowsLogin = false;
      try {
        uiShowsLogin = deps.nativeSessionReady(adapterId, options.model);
      } catch {
        // A leitura da UI não substitui a recusa já medida pelo probe.
      }
      if (uiShowsLogin) {
        const authPath = adapterId === 'muse'
          ? `~/.config/muse/auth.json e Keychain ${MUSE_KEYCHAIN_SERVICE}/meta`
          : `configuração nativa de auth do ${adapterId}`;
        const detail =
          'credencial recusada pelo probe, mas a UI mostra login; ' +
          `verifique ${authPath}`;
        trace({ kind: 'probe-divergence', adapterId });
        console.warn(`[probe-divergence] ${adapterId}: ${detail}`);
        return { ...failure, hint: `${detail}; ${failure.hint}` };
      }
    }
    if (!failure) recentCredentialFailures.delete(adapterId);
    return failure;
  } catch (err) {
    if (options.failClosed) {
      console.warn(
        '[pre-spawn-probe] probe failed; blocking governed spawn:',
        err,
      );
      return {
        code: 'probe-unavailable',
        adapterId,
        hint:
          'não foi possível comprovar a prontidão do CLI; tente novamente ' +
          'ou revise Configurações › Contas de IA',
      };
    }
    // A direct user terminal may still open when the lightweight precheck is
    // unavailable; it carries no autonomous mission authority from this seam.
    console.warn('[pre-spawn-probe] probe failed; passing through:', err);
    return null;
  }
}

/** Throwing variant used on the agent spawn path (tool-util). */
export async function assertPreSpawnProbe(
  adapterId: string,
  options: PreSpawnProbeOptions = {},
): Promise<void> {
  const failure = await probePreSpawn(adapterId, options);
  if (failure) throw new PreSpawnProbeError(failure);
}
