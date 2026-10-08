// Adapted from pingdotgg/t3code @ 26285ab80513260d1ff29d2c3fbe18f21990cb62
// Copyright (c) 2026 T3 Tools Inc. — MIT License
// See third_party/licenses/t3code-MIT.txt. Nexus changes: ChromiumKeys.ts sem Effect — resultado {ok:false, reason}; Keychain pela AsyncEntry do @napi-rs/keyring (thread do libuv, nunca bloqueia o Main durante o modal); Linux v11 pelo /usr/bin/secret-tool do sistema no lugar do helper nativo empacotado do T3 Code; App-Bound do Windows vira motivo próprio (`appBound`); DPAPI por PowerShell com prazo.
import { pbkdf2Sync } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';
import { z } from 'zod';

const KEY_SALT = 'saltysalt';
const KEY_LENGTH = 16;
/** macOS stretches the keychain secret; Linux uses a single iteration. */
const MAC_KEY_ITERATIONS = 1003;
const LINUX_KEY_ITERATIONS = 1;
/** Chromium's documented fallback passphrase when no Linux keyring is present. */
const LINUX_FALLBACK_PASSPHRASE = 'peanuts';

export type ChromiumKeyFailure =
  | 'needsKeychainApproval'
  | 'keychainItemMissing'
  | 'keychainUnavailable'
  /** Windows App-Bound Encryption: only the browser itself can unwrap the key. */
  | 'appBound'
  | 'unsupportedPlatform'
  /** The key store itself could not be read, as opposed to holding no key. */
  | 'readFailed';
export type KeyResult<T> = { ok: true; value: T } | { ok: false; reason: ChromiumKeyFailure };

/**
 * Keys to try, indexed by the record prefix they decrypt. A database can hold
 * records written under more than one scheme, so a missing entry means those
 * records are skipped rather than the whole import failing.
 */
export interface ChromiumKeyMaterial {
  /** AES-128-CBC on macOS, and the keyring-free Linux fallback. */
  cbcV10?: Buffer;
  /** AES-128-CBC, Linux keyring-derived. */
  cbcV11?: Buffer;
  /** Retained so an import that needed this key can say why it is missing. */
  cbcV11Error?: ChromiumKeyFailure;
  /** AES-128-CBC from an empty passphrase (crbug.com/1195256), retried after a record's own key fails. */
  cbcEmpty?: Buffer;
  /** AES-256-GCM key used by pre-App-Bound Chromium on Windows. */
  gcmV10?: Buffer;
}

const derive = (passphrase: string, iterations: number) =>
  pbkdf2Sync(passphrase, KEY_SALT, iterations, KEY_LENGTH, 'sha1');

interface KeyringModule {
  AsyncEntry: new (service: string, account: string) => { getPassword(): Promise<string | null | undefined> };
}
// Loaded on first use only: platforms that never import from Chromium never
// load the binding. `__filename` survives the CommonJS main bundle (see ocr.ts).
export const loadKeyring = (): KeyringModule => createRequire(__filename)('@napi-rs/keyring') as KeyringModule;

/**
 * Reads the macOS OSCrypt secret from the login keychain, in process.
 *
 * Shelling out to `/usr/bin/security` made macOS attribute both the consent
 * prompt and the "Always Allow" ACL entry to that binary, which every process
 * of the user can run: the grant handed the browser's cookie key to all of
 * them. In process, the prompt names this app and the grant belongs to it.
 *
 * Deliberately untimed: macOS answers with a modal, and a timeout racing the
 * user means the prompt can be approved after nothing is listening anymore.
 * AsyncEntry runs on the libuv pool, so Main stays responsive meanwhile.
 */
export async function readKeychainSecret(
  service: string, account: string, load: () => KeyringModule = loadKeyring,
): Promise<KeyResult<string>> {
  let keyring: KeyringModule;
  try { keyring = load(); } catch { return { ok: false, reason: 'keychainUnavailable' }; }
  try {
    const secret = await new keyring.AsyncEntry(service, account).getPassword();
    return secret ? { ok: true, value: secret } : { ok: false, reason: 'keychainItemMissing' };
  } catch (cause) {
    // Distinguish the causes rather than asking to approve a prompt that
    // cannot fix the failure. The error text never leaves this function.
    const message = String((cause as { message?: unknown } | undefined)?.message ?? '');
    return { ok: false, reason: /no (matching )?entry|not found/i.test(message) ? 'keychainItemMissing' : 'needsKeychainApproval' };
  }
}

type RunFile = (file: string, args: string[], options: { encoding: 'utf8'; timeout: number; maxBuffer: number }) =>
  Promise<{ stdout: string }>;
const execFileAsync = promisify(execFile) as unknown as RunFile;

/**
 * Chromium on Linux keeps the v11 secret in the Secret Service under its own
 * schema, keyed by the `application` attribute. `secret-tool` (libsecret) is
 * the system's own client, so this adds no native dependency; it is called by
 * absolute path, never searched on PATH. The keyring may show its unlock
 * prompt, so the bound is a safety net, not a race against the user.
 */
export async function readLinuxSecret(application: string, run: RunFile = execFileAsync): Promise<KeyResult<string>> {
  try {
    const { stdout } = await run('/usr/bin/secret-tool', ['lookup', 'application', application], {
      encoding: 'utf8', timeout: 300_000, maxBuffer: 65_536,
    });
    // The stored secret is used byte for byte, trailing whitespace included.
    return stdout ? { ok: true, value: stdout } : { ok: false, reason: 'keychainItemMissing' };
  } catch {
    // Missing tool, no D-Bus session, locked or empty keyring: secret-tool
    // reports them all as exit 1 with localized text, so they stay one reason.
    return { ok: false, reason: 'keychainUnavailable' };
  }
}

const windowsLocalStateSchema = z.object({
  os_crypt: z.object({ encrypted_key: z.string(), app_bound_encrypted_key: z.string().optional() }),
});
const DPAPI_PREFIX = Buffer.from('DPAPI');
const WINDOWS_KEY_LENGTH = 32;
const WINDOWS_DPAPI_SCRIPT =
  'Add-Type -AssemblyName System.Security;' +
  '$value=[Console]::In.ReadToEnd();' +
  '$encrypted=[Convert]::FromBase64String($value);' +
  '$plain=[Security.Cryptography.ProtectedData]::Unprotect($encrypted,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);' +
  '[Console]::Out.Write([Convert]::ToBase64String($plain))';

export function decodeWindowsWrappedKey(contents: string): KeyResult<Buffer> {
  let state: z.infer<typeof windowsLocalStateSchema>;
  try {
    const parsed = windowsLocalStateSchema.safeParse(JSON.parse(contents));
    if (!parsed.success) return { ok: false, reason: 'readFailed' };
    state = parsed.data;
  } catch { return { ok: false, reason: 'readFailed' }; }
  // Chrome 127+ binds the key to the browser's own identity; reading it from
  // outside would mean defeating that protection, so it stays unsupported.
  if (state.os_crypt.app_bound_encrypted_key !== undefined) return { ok: false, reason: 'appBound' };
  const wrapped = Buffer.from(state.os_crypt.encrypted_key, 'base64');
  if (!wrapped.subarray(0, DPAPI_PREFIX.length).equals(DPAPI_PREFIX)) return { ok: false, reason: 'readFailed' };
  return { ok: true, value: wrapped.subarray(DPAPI_PREFIX.length) };
}

/** Unwraps a key with the current Windows user's DPAPI identity, passing it on stdin, never in argv. */
export function unwrapWindowsDpapiKey(
  wrapped: Buffer, env: NodeJS.ProcessEnv = process.env, spawnProcess: typeof spawn = spawn,
): Promise<KeyResult<Buffer>> {
  const windowsRoot = env.SystemRoot ?? env.WINDIR;
  const powershell = windowsRoot ? `${windowsRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe` : 'powershell.exe';
  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (result: KeyResult<Buffer>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawnProcess(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', WINDOWS_DPAPI_SCRIPT], {
        env, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true,
      });
    } catch { finish({ ok: false, reason: 'keychainUnavailable' }); return; }
    // DPAPI shows no UI; this bound only stops a stuck PowerShell.
    timer = setTimeout(() => { child.kill(); finish({ ok: false, reason: 'readFailed' }); }, 60_000);
    let stdout = '';
    child.on('error', () => finish({ ok: false, reason: 'keychainUnavailable' }));
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk;
      if (stdout.length > 4096) { child.kill(); finish({ ok: false, reason: 'readFailed' }); }
    });
    child.on('close', (code) => {
      if (code !== 0) { finish({ ok: false, reason: 'readFailed' }); return; }
      const plain = Buffer.from(stdout.trim(), 'base64');
      finish(plain.length === WINDOWS_KEY_LENGTH ? { ok: true, value: plain } : { ok: false, reason: 'readFailed' });
    });
    child.stdin?.end(wrapped.toString('base64'));
  });
}

/** Reads and unwraps a legacy (non-App-Bound) Windows Chromium key. */
export async function readWindowsKey(localStatePath: string): Promise<KeyResult<Buffer>> {
  let contents: string;
  try {
    if (fs.statSync(localStatePath).size > 4 * 1024 * 1024) return { ok: false, reason: 'readFailed' };
    contents = fs.readFileSync(localStatePath, 'utf8');
  } catch { return { ok: false, reason: 'readFailed' }; }
  const wrapped = decodeWindowsWrappedKey(contents);
  return wrapped.ok ? unwrapWindowsDpapiKey(wrapped.value) : wrapped;
}

export interface ChromiumKeyRequest {
  platform: NodeJS.Platform;
  keychainService?: string;
  keychainAccount?: string;
  linuxSecretApplication?: string;
  windowsLocalStatePath?: string;
}
export interface ChromiumKeyReaders {
  keychain?: (service: string, account: string) => Promise<KeyResult<string>>;
  linux?: (application: string) => Promise<KeyResult<string>>;
  windows?: (localStatePath: string) => Promise<KeyResult<Buffer>>;
}

export async function resolveChromiumKeys(
  request: ChromiumKeyRequest, readers: ChromiumKeyReaders = {},
): Promise<KeyResult<ChromiumKeyMaterial>> {
  if (request.platform === 'darwin') {
    if (!request.keychainService || !request.keychainAccount) return { ok: false, reason: 'unsupportedPlatform' };
    const secret = await (readers.keychain ?? readKeychainSecret)(request.keychainService, request.keychainAccount);
    return secret.ok ? { ok: true, value: { cbcV10: derive(secret.value, MAC_KEY_ITERATIONS) } } : secret;
  }
  if (request.platform === 'linux') {
    // The fallback passphrase always applies to v10 records; a keyring secret,
    // when reachable, additionally unlocks v11. Its failure is kept until the
    // reader knows whether any cookie actually needed that key.
    const keyring = request.linuxSecretApplication
      ? await (readers.linux ?? readLinuxSecret)(request.linuxSecretApplication) : undefined;
    return { ok: true, value: {
      cbcV10: derive(LINUX_FALLBACK_PASSPHRASE, LINUX_KEY_ITERATIONS),
      ...(keyring?.ok ? { cbcV11: derive(keyring.value, LINUX_KEY_ITERATIONS) } : keyring ? { cbcV11Error: keyring.reason } : {}),
      cbcEmpty: derive('', LINUX_KEY_ITERATIONS),
    } };
  }
  if (request.platform === 'win32' && request.windowsLocalStatePath) {
    const key = await (readers.windows ?? readWindowsKey)(request.windowsLocalStatePath);
    return key.ok ? { ok: true, value: { gcmV10: key.value } } : key;
  }
  return { ok: false, reason: 'unsupportedPlatform' };
}

/** Overwrites every derived key; callers hold them only for the decode loop. */
export function wipeChromiumKeys(keys: ChromiumKeyMaterial | undefined): void {
  for (const key of [keys?.cbcV10, keys?.cbcV11, keys?.cbcEmpty, keys?.gcmV10]) key?.fill(0);
}
