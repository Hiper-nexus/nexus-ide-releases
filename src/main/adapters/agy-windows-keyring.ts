/**
 * AGY no Windows guarda o login de consumidor numa vaga ÚNICA do Gerenciador
 * de Credenciais (`gemini:antigravity`, go-keyring/wincred). Medido em
 * 28/09 com o AGY 1.2.12 (F-677): HOME/USERPROFILE/GEMINI_CLI_HOME isolados,
 * `JETSKI_APP_DATA_DIR` e `ANTIGRAVITY_APP_DATA_DIR` não mudam a vaga — o
 * `keyringAuth` vem primeiro na cadeia e autentica qualquer pane com a conta
 * que estiver nela. O refresh do token passa pelo servidor do Google (o
 * cliente OAuth do Antigravity não tem segredo utilizável fora da CLI), então
 * ADC `authorized_user` não serve de rota por pane.
 *
 * Ler e gravar essa vaga é a única forma de o Nexus escolher a conta AGY de
 * um pane no Windows. Nenhum segredo passa por argv ou log: o blob viaja por
 * stdin em base64 e o resultado volta pelo stdout do PowerShell.
 */
import { execFileSync } from 'node:child_process';

export const AGY_KEYRING_TARGET = 'gemini:antigravity';
/** UserName que o go-keyring grava (service:user → target). */
const AGY_KEYRING_USER = 'antigravity';
/** CRED_MAX_CREDENTIAL_BLOB_SIZE (5 * 512). */
const MAX_BLOB_BYTES = 2_560;
const READ_TTL_MS = 15_000;
const POWERSHELL_TIMEOUT_MS = 8_000;

const CRED_TYPE = String.raw`Add-Type @"
using System; using System.Runtime.InteropServices; using System.Text;
public class NexusAgyKeyring {
  [DllImport("advapi32", SetLastError=true, CharSet=CharSet.Unicode)]
  public static extern bool CredRead(string t, int type, int f, out IntPtr p);
  [DllImport("advapi32", SetLastError=true, CharSet=CharSet.Unicode)]
  public static extern bool CredWrite(ref C c, uint flags);
  [DllImport("advapi32")] public static extern void CredFree(IntPtr p);
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public struct C { public uint Flags; public uint Type; public IntPtr TargetName; public IntPtr Comment; public long LastWritten; public uint CredentialBlobSize; public IntPtr CredentialBlob; public uint Persist; public uint AttributeCount; public IntPtr Attributes; public IntPtr TargetAlias; public IntPtr UserName; }
  public static string Read(string target) { IntPtr p; if (!CredRead(target, 1, 0, out p)) return ""; try { var c = Marshal.PtrToStructure<C>(p); if (c.CredentialBlobSize == 0) return ""; var b = new byte[c.CredentialBlobSize]; Marshal.Copy(c.CredentialBlob, b, 0, b.Length); return Convert.ToBase64String(b); } finally { CredFree(p); } }
  public static bool Write(string target, string user, byte[] blob) {
    var c = new C(); c.Type = 1; c.Persist = 2;
    c.TargetName = Marshal.StringToCoTaskMemUni(target); c.UserName = Marshal.StringToCoTaskMemUni(user);
    c.CredentialBlobSize = (uint)blob.Length; c.CredentialBlob = Marshal.AllocCoTaskMem(blob.Length);
    try { Marshal.Copy(blob, 0, c.CredentialBlob, blob.Length); return CredWrite(ref c, 0); }
    finally { Marshal.FreeCoTaskMem(c.TargetName); Marshal.FreeCoTaskMem(c.UserName); Marshal.FreeCoTaskMem(c.CredentialBlob); }
  }
}
"@`;

const READ_SCRIPT = `${CRED_TYPE}
[Console]::Out.Write([NexusAgyKeyring]::Read('${AGY_KEYRING_TARGET}'))`;

const WRITE_SCRIPT = `${CRED_TYPE}
$b = [Convert]::FromBase64String(([Console]::In.ReadToEnd()).Trim())
if ([NexusAgyKeyring]::Write('${AGY_KEYRING_TARGET}', '${AGY_KEYRING_USER}', $b)) { [Console]::Out.Write('ok') } else { [Console]::Out.Write('fail') }`;

type ExecFileSync = typeof execFileSync;

let readCache: { at: number; value: string | null } | null = null;

export function invalidateAgyWindowsKeyringCache(): void {
  readCache = null;
}

function runPowerShell(exec: ExecFileSync, script: string, input?: string): string {
  const out = exec(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    {
      encoding: 'utf8',
      timeout: POWERSHELL_TIMEOUT_MS,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'ignore'],
      ...(input !== undefined ? { input } : {}),
    },
  );
  return typeof out === 'string' ? out.trim() : '';
}

/** go-keyring grava bytes UTF-8 crus; algumas versões prefixam base64. */
export function decodeAgyKeyringPayload(bytes: Buffer): string | null {
  const text = bytes.toString('utf8').trim();
  if (!text) return null;
  const prefix = 'go-keyring-base64:';
  if (text.startsWith(prefix)) {
    const inner = Buffer.from(text.slice(prefix.length), 'base64').toString('utf8').trim();
    return inner || null;
  }
  return text;
}

/**
 * O blob atual da vaga (JSON `{token, auth_method, id_token}`), ou null.
 * Cache curto: `captureNativeAuth` é chamada por snapshots de provider.
 */
export function readAgyWindowsKeyringBlob(options: {
  fresh?: boolean;
  exec?: ExecFileSync;
  now?: number;
  platform?: NodeJS.Platform;
} = {}): string | null {
  if ((options.platform ?? process.platform) !== 'win32') return null;
  // Testes nunca tocam a vaga real do operador: só com exec injetado.
  if (!options.exec && process.env.VITEST) return null;
  const now = options.now ?? Date.now();
  if (!options.fresh && readCache && now - readCache.at < READ_TTL_MS) {
    return readCache.value;
  }
  let value: string | null = null;
  try {
    const encoded = runPowerShell(options.exec ?? execFileSync, READ_SCRIPT);
    value = encoded ? decodeAgyKeyringPayload(Buffer.from(encoded, 'base64')) : null;
  } catch {
    value = null;
  }
  readCache = { at: now, value };
  return value;
}

/** Grava `blob` na vaga do AGY. Falso em qualquer falha — nunca lança com segredo. */
export function writeAgyWindowsKeyringBlob(
  blob: string,
  options: { exec?: ExecFileSync; platform?: NodeJS.Platform } = {},
): boolean {
  if ((options.platform ?? process.platform) !== 'win32') return false;
  if (!options.exec && process.env.VITEST) return false;
  const bytes = Buffer.from(blob, 'utf8');
  if (bytes.length === 0 || bytes.length > MAX_BLOB_BYTES) return false;
  invalidateAgyWindowsKeyringCache();
  try {
    return runPowerShell(options.exec ?? execFileSync, WRITE_SCRIPT, bytes.toString('base64')) === 'ok';
  } catch {
    return false;
  } finally {
    invalidateAgyWindowsKeyringCache();
  }
}

/**
 * Formato da vaga do keyring (o mesmo do arquivo `antigravity-oauth-token`):
 * token OAuth aninhado + `id_token`. Blob de `oauth_creds.json` (Gemini CLI)
 * não serve para a vaga — o AGY não reconstrói a identidade sem o id_token.
 */
export function isAgyKeyringBlob(blob: string): boolean {
  try {
    const parsed = JSON.parse(blob) as Record<string, unknown>;
    const token = parsed?.token as Record<string, unknown> | undefined;
    return Boolean(
      token && typeof token === 'object' &&
      typeof token.refresh_token === 'string' && token.refresh_token &&
      typeof parsed.id_token === 'string' && parsed.id_token,
    );
  } catch {
    return false;
  }
}
