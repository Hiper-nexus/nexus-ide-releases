import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getAdapter } from '../adapters/adapter-registry';
import { readActiveClaudeCredential } from '../adapters/claude-credential';
import {
  hasNativeFileAuth,
  isFileAuthAdapter,
} from '../adapters/managed-credentials';
import { resolveOmpBin } from '../adapters/omp-rpc-service';
import { claudeOauthEmail } from '../adapters/subscription-auth';
import { listAccounts } from '../persistence/account-store';
import { hasRuntimeKey } from '../persistence/provider-config-store';

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
 *    adapter → pass. A probe internal failure → pass (logged). Runtime-broken
 *    credentials that still LOOK present are the login-stuck watchdog's job
 *    (orch/login-stuck-watchdog.ts), not this module's.
 */

export type PreSpawnProbeCode =
  | 'missing-credential'
  | 'binary-missing'
  | 'key-missing';

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
}

export interface PreSpawnProbeDeps {
  getAdapter(adapterId: string): ProbeAdapterView | null;
  listAccounts(adapterId: string): readonly unknown[];
  hasStoredKey(adapterId: string): boolean;
  readActiveClaudeCredential(): string | null;
  readClaudeCredentialsFile(): string | null;
  claudeOauthEmail(): string | null;
  hasNativeFileAuth(adapterId: string): boolean;
  resolveOmpBin(): Promise<unknown>;
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
  hasStoredKey: (adapterId) => hasRuntimeKey(adapterId),
  readActiveClaudeCredential,
  readClaudeCredentialsFile,
  claudeOauthEmail: () => claudeOauthEmail(),
  hasNativeFileAuth: (adapterId) => hasNativeFileAuth(adapterId),
  resolveOmpBin: () => resolveOmpBin(),
};

function hintFor(adapter: ProbeAdapterView, fallback: string): string {
  return adapter.auth?.loginHint ?? fallback;
}

async function probe(
  adapterId: string,
  deps: PreSpawnProbeDeps,
): Promise<PreSpawnProbeFailure | null> {
  const adapter = deps.getAdapter(adapterId);
  // Unknown adapters are rejected by the spawn gate itself — not ours to judge.
  if (!adapter) return null;

  // omp: resolveOmpBin already IS the probe (PATH lookup with login-shell
  // fallback, cached for the process lifetime). A version-pin mismatch is NOT
  // binary-missing — the rpc spawn path already fails it with the exact
  // message, so only the PATH lookup failure is mapped here.
  if (adapterId === 'omp') {
    try {
      await deps.resolveOmpBin();
      return null;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!/não encontrado no PATH|not found/i.test(message)) return null;
      return {
        code: 'binary-missing',
        adapterId,
        hint: 'instale o omp com `brew install can1357/tap/omp` e tente de novo',
      };
    }
  }

  // A Nexus-managed account means the pinned-account path will validate the
  // credential (prepareAccountForSpawn already fails those cases well).
  if (deps.listAccounts(adapterId).length > 0) return null;

  if (adapterId === 'claude') {
    if (deps.readActiveClaudeCredential() !== null) return null;
    if (deps.readClaudeCredentialsFile() !== null) return null;
    if (deps.hasStoredKey(adapterId)) return null;
    // Packaged Electron often CANNOT read the login keychain (TCC) even when
    // the CLI is fully logged in — an oauthAccount email in ~/.claude.json
    // marks a login we cannot fully judge → pass rather than block a healthy
    // user. A genuinely broken credential with the email still present is the
    // login-stuck watchdog's job, not this probe's.
    if (deps.claudeOauthEmail() !== null) return null;
    return {
      code: 'missing-credential',
      adapterId,
      hint: hintFor(
        adapter,
        'rode `claude` num terminal para autenticar, ou adicione a conta em Configurações › Contas',
      ),
    };
  }

  // File-backed subscription CLIs (codex/grok/kimi/opencode/agy): the native
  // auth file (or a managed account's home, covered above) must exist.
  if (isFileAuthAdapter(adapterId)) {
    if (deps.hasNativeFileAuth(adapterId)) return null;
    if (deps.hasStoredKey(adapterId)) return null;
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
    if (deps.hasStoredKey(adapterId)) return null;
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
  deps: PreSpawnProbeDeps = defaultDeps,
): Promise<PreSpawnProbeFailure | null> {
  try {
    return await probe(adapterId, deps);
  } catch (err) {
    // A probe bug must never block a spawn: unjudged means pass.
    console.warn('[pre-spawn-probe] probe failed; passing through:', err);
    return null;
  }
}

/** Throwing variant used on the agent spawn path (tool-util). */
export async function assertPreSpawnProbe(
  adapterId: string,
  deps: PreSpawnProbeDeps = defaultDeps,
): Promise<void> {
  const failure = await probePreSpawn(adapterId, deps);
  if (failure) throw new PreSpawnProbeError(failure);
}
