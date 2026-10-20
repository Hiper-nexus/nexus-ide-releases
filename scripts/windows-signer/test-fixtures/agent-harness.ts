import { spawn } from 'node:child_process';
import { X509Certificate, createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import agent from '../agent.cjs';

// Mesmo certificado de teste de build/windows-token-signing.test.ts (P-256, até 2126).
export const TEST_CERTIFICATE = new X509Certificate(`-----BEGIN CERTIFICATE-----
MIICejCCAiCgAwIBAgIUEJfeAP5jNOSpRg/vC7xTqazJNj4wCgYIKoZIzj0EAwIw
fzELMAkGA1UEBhMCQlIxNzA1BgNVBAoMLkhJUEVSU0VORCBURUNOT0xPR0lBIElO
VEVSTkVUICYgU09GVFdBUkVTIExUREExNzA1BgNVBAMMLkhJUEVSU0VORCBURUNO
T0xPR0lBIElOVEVSTkVUICYgU09GVFdBUkVTIExUREEwIBcNMjYxMDE5MTUyMDQw
WhgPMjEyNjA5MjUxNTIwNDBaMH8xCzAJBgNVBAYTAkJSMTcwNQYDVQQKDC5ISVBF
UlNFTkQgVEVDTk9MT0dJQSBJTlRFUk5FVCAmIFNPRlRXQVJFUyBMVERBMTcwNQYD
VQQDDC5ISVBFUlNFTkQgVEVDTk9MT0dJQSBJTlRFUk5FVCAmIFNPRlRXQVJFUyBM
VERBMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEId4wpZZ7lQb0POOZ+HZ1+fko
IzXrJiXwO6pUwdj6oYJo5gt6l/WjPO2b0EM4tce2INZRUigAc2gAQr1Rks6w4aN4
MHYwHQYDVR0OBBYEFCw/eMwbWXwyh5p+/vWuvzlwZvP7MB8GA1UdIwQYMBaAFCw/
eMwbWXwyh5p+/vWuvzlwZvP7MA8GA1UdEwEB/wQFMAMBAf8wEwYDVR0lBAwwCgYI
KwYBBQUHAwMwDgYDVR0PAQH/BAQDAgeAMAoGCCqGSM49BAMCA0gAMEUCIQCTUilQ
bxUSCpDwTqtVuFs+vsXnN126lkLwrzhnmjtn8QIgGpDsnhc8lYWVISnmGuypblQU
RPueEhHQJbOiNAJCo3U=
-----END CERTIFICATE-----`);
export const TEST_THUMBPRINT = TEST_CERTIFICATE.fingerprint.replaceAll(':', '');
export const TEST_SPKI = createHash('sha256')
  .update(TEST_CERTIFICATE.publicKey.export({ type: 'spki', format: 'der' }))
  .digest('hex');

const FAKE_ENGINE = path.join(__dirname, 'fake-engine.cjs');

export interface TestAgent {
  directory: string;
  checkout: string;
  localAppData: string;
  engineLog: () => string[];
  info: { pid: number; pipe: string; thumbprint: string; startedAt: number; expiresAt: number | null; pinMode: string; parentPid: number | null };
  stopped: Promise<string>;
}

/** Checkout falso que fixa `thumbprint`, com um executável em out\. */
export function makeCheckout(root: string, thumbprint = TEST_THUMBPRINT): string {
  const checkout = path.join(root, 'checkout');
  mkdirSync(path.join(checkout, 'build'), { recursive: true });
  mkdirSync(path.join(checkout, 'out', 'NexusIDE-win32-x64'), { recursive: true });
  writeFileSync(
    path.join(checkout, 'build', 'windows-signing-identity.json'),
    JSON.stringify({ certificateSha1: thumbprint }),
  );
  return checkout;
}

/** Checkout falso do Nexus Shot (Tauri) que fixa `thumbprint`, com a saída do NSIS em target\release. */
export function makeShotCheckout(root: string, thumbprint = TEST_THUMBPRINT): string {
  const checkout = path.join(root, 'nexus-shot');
  mkdirSync(path.join(checkout, 'src-tauri', 'target', 'release', 'nsis', 'x64', 'Plugins', 'x86-unicode', 'additional'), { recursive: true });
  writeFileSync(
    path.join(checkout, 'src-tauri', 'windows-signing-identity.json'),
    JSON.stringify({ schemaVersion: 1, signing: 'yubikey', certificateSha1: thumbprint }),
  );
  return checkout;
}

/** Agente real (pipe, token, política, diário) com o motor falso no lugar do cartão. */
export async function startTestAgent({
  hours = 24,
  lockAfter,
  expectedSpki = TEST_SPKI,
  thumbprint = TEST_THUMBPRINT,
  hasPrivateKey = true,
  pinMode,
  parentPid,
  savedPin = false,
  fakeEnv = {},
  root = mkdtempSync(path.join(os.tmpdir(), 'nexus-signer-test-')),
  now,
}: {
  hours?: number;
  lockAfter?: number;
  expectedSpki?: string;
  thumbprint?: string;
  hasPrivateKey?: boolean;
  pinMode?: 'prompt' | 'save' | 'stored';
  /** Amarra o agente a este processo (modo 0 h). */
  parentPid?: number;
  /** Cria o pin.dpapi falso antes de subir o agente. */
  savedPin?: boolean;
  fakeEnv?: Record<string, string>;
  root?: string;
  now?: () => number;
} = {}): Promise<TestAgent> {
  const directory = path.join(root, 'agent');
  mkdirSync(directory, { recursive: true });
  if (savedPin) writeFileSync(agent.pinFilePath(directory), 'sealed-by-dpapi');
  const localAppData = path.join(root, 'local');
  mkdirSync(path.join(localAppData, 'SquirrelTemp'), { recursive: true });
  const checkout = makeCheckout(root);
  const logFile = path.join(root, 'engine.log');
  writeFileSync(logFile, '');
  let ready!: (info: TestAgent['info']) => void;
  const readyPromise = new Promise<TestAgent['info']>((resolve) => { ready = resolve; });
  const stopped = agent.runAgent({
    thumbprint,
    expectedSpkiSha256: expectedSpki,
    hours,
    pinMode,
    parentPid,
    directory,
    env: { ...process.env, LOCALAPPDATA: localAppData },
    now,
    spawnEngine: (childEnv: NodeJS.ProcessEnv) => spawn(process.execPath, [FAKE_ENGINE], {
      env: {
        ...childEnv,
        FAKE_ENGINE_CERT: TEST_CERTIFICATE.raw.toString('base64'),
        FAKE_ENGINE_HAS_KEY: hasPrivateKey ? '1' : '0',
        FAKE_ENGINE_LOG: logFile,
        ...(lockAfter === undefined ? {} : { FAKE_ENGINE_LOCK_AFTER: String(lockAfter) }),
        ...fakeEnv,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    }),
    onReady: ready,
  });
  const info = await Promise.race([
    readyPromise,
    stopped.then(() => { throw new Error('the test agent stopped before it was ready'); }),
  ]);
  return {
    directory,
    checkout,
    localAppData,
    engineLog: () => readFileSync(logFile, 'utf8').split('\n').filter(Boolean),
    info,
    stopped,
  };
}
