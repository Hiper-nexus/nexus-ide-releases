import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getAdapter } from '../adapters/adapter-registry';
import {
  claudeCredentialBlobIsUsable,
  readActiveClaudeCredential,
} from '../adapters/claude-credential';
import {
  hasNativeFileAuth,
  isFileAuthAdapter,
} from '../adapters/managed-credentials';
import {
  claudeOauthEmail,
  type AuthStrategy,
} from '../adapters/subscription-auth';
import { isCredentiallessOpenCodeModel } from '../adapters/model-auth-readiness';
import { listAccounts } from '../persistence/account-store';
import {
  hasRuntimeKey,
  providerAuthStrategy,
  providerAuthStrategyAuthoritative,
} from '../persistence/provider-config-store';

/**
 * Pre-spawn credential probe (Overclock v1.2 harvest, fix F-256): a spawn
 * issued with a missing credential used to surface as a dead pane or a mute
 * login TUI. This probe runs BEFORE the pane exists — cheap (<50ms warm, no
 * network; every check is a stat/keychain read or a cached binary lookup) —
 * and turns that blind spawn into a typed, actionable error.
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
  hasNativeFileAuth(adapterId: string): boolean;
  authStrategy(adapterId: string, model?: string): AuthStrategy;
  /** Optional uncached authority used only at autonomous process creation. */
  authoritativeAuthStrategy?(
    adapterId: string,
    model?: string,
  ): AuthStrategy;
}

export interface PreSpawnProbeOptions {
  /** Exact model selected for this spawn; absent means the adapter default. */
  readonly model?: string;
  /**
   * Explicit Hardened spawns cannot treat an unavailable readiness proof as
   * permission. Autopilot/direct terminals retain the unjudged fallback.
   */
  readonly failClosed?: boolean;
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

const defaultDeps: PreSpawnProbeDeps = {
  getAdapter: (adapterId) => getAdapter(adapterId),
  listAccounts: (adapterId) => listAccounts(adapterId),
  hasStoredKey: (adapterId, model) => hasRuntimeKey(adapterId, model),
  readActiveClaudeCredential,
  readClaudeCredentialsFile,
  claudeOauthEmail: () => claudeOauthEmail(),
  hasNativeFileAuth: (adapterId) => hasNativeFileAuth(adapterId),
  authStrategy: (adapterId, model) =>
    providerAuthStrategy(adapterId, model),
  authoritativeAuthStrategy: (adapterId, model) =>
    providerAuthStrategyAuthoritative(adapterId, model),
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

  // This is the last spawn barrier, so a readiness regression after squad
  // selection must fail closed. A stale Nexus account row is not proof of
  // current provider authentication.
  if (
    deps.authStrategy(adapterId, effectiveModel) === 'login-needed' &&
    !credentiallessOpenCode
  ) {
    return {
      code: 'missing-credential',
      adapterId,
      hint: hintFor(
        adapter,
        'faça login no CLI ou adicione a conta em Configurações › Contas',
      ),
    };
  }

  // A Nexus-managed account means the pinned-account path will validate the
  // credential (prepareAccountForSpawn already fails those cases well).
  if (managedAccountAvailable) return null;

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
        'rode `claude auth login` num terminal para autenticar, ou adicione a conta em Configurações › Contas',
      ),
    };
  }

  // File-backed subscription CLIs (codex/grok/kimi/opencode/agy): the native
  // auth file (or a managed account's home, covered above) must exist.
  if (isFileAuthAdapter(adapterId)) {
    // OpenCode's own pinned free catalog is usable without provider auth.
    // The exact model matters: external OpenRouter routes and unreviewed
    // `opencode/*-free` lookalikes must still fail before a pane exists.
    if (credentiallessOpenCode) return null;
    if (deps.hasNativeFileAuth(adapterId)) return null;
    if (deps.hasStoredKey(adapterId, effectiveModel)) return null;
    return {
      code: 'missing-credential',
      adapterId,
      hint: hintFor(
        adapter,
        'faça login no CLI ou adicione a conta em Configurações › Contas',
      ),
    };
  }

  // Pure API-key routes (glm/longcat/aider) and future api-provider adapters:
  // the key is the only credential there is.
  const authMethod =
    adapter.kind === 'cli-pty' ? adapter.auth?.method : 'api_key';
  if (authMethod === 'api_key') {
    if (deps.hasStoredKey(adapterId, effectiveModel)) return null;
    return {
      code: 'key-missing',
      adapterId,
      hint: hintFor(adapter, 'cole a API key em Configurações › Providers'),
    };
  }

  // subscription / device_code / none without a dedicated probe → unjudged.
  return null;
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
    return await probe(
      adapterId,
      options.model,
      options.deps ?? defaultDeps,
      options.failClosed === true,
    );
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
          'ou revise Configurações › Providers',
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
