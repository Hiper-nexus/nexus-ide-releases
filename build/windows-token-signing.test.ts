import { spawnSync } from 'node:child_process';
import { X509Certificate, createPublicKey } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  ESIGNER_CERTIFICATE_SHA1,
  WINDOWS_SIGNING_IDENTITY,
  assertWindowsTokenCertificate,
  assertWindowsTokenSigningReady,
  parseWindowsSigningIdentity,
  readCurrentUserCertificate,
  windowsCertificateSpkiSha256,
  windowsTokenSignerThumbprint,
  type WindowsSigningIdentity,
} from './windows-token-signing';

// Certificados de teste autoassinados (P-256, válidos até 2126) com a mesma
// chave: um para assinatura de código e outro só para servidor TLS.
const CODE_SIGNING_PEM = `-----BEGIN CERTIFICATE-----
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
-----END CERTIFICATE-----`;

const SERVER_AUTH_PEM = `-----BEGIN CERTIFICATE-----
MIIB+DCCAZ6gAwIBAgIUNv96QS4RlZxflAEAS/KtiOp9lZMwCgYIKoZIzj0EAwIw
RjELMAkGA1UEBhMCQlIxNzA1BgNVBAMMLkhJUEVSU0VORCBURUNOT0xPR0lBIElO
VEVSTkVUICYgU09GVFdBUkVTIExUREEwIBcNMjYxMDE5MTUyMDQwWhgPMjEyNjA5
MjUxNTIwNDBaMEYxCzAJBgNVBAYTAkJSMTcwNQYDVQQDDC5ISVBFUlNFTkQgVEVD
Tk9MT0dJQSBJTlRFUk5FVCAmIFNPRlRXQVJFUyBMVERBMFkwEwYHKoZIzj0CAQYI
KoZIzj0DAQcDQgAEId4wpZZ7lQb0POOZ+HZ1+fkoIzXrJiXwO6pUwdj6oYJo5gt6
l/WjPO2b0EM4tce2INZRUigAc2gAQr1Rks6w4aNoMGYwHQYDVR0OBBYEFCw/eMwb
WXwyh5p+/vWuvzlwZvP7MB8GA1UdIwQYMBaAFCw/eMwbWXwyh5p+/vWuvzlwZvP7
MA8GA1UdEwEB/wQFMAMBAf8wEwYDVR0lBAwwCgYIKwYBBQUHAwEwCgYIKoZIzj0E
AwIDSAAwRQIgT/0VfZYUe0HRyR2N/uJupKq/AWo3jGZHjIWeRowtlaQCIQCMni3R
PjKGCGp+69K5iidHwlLcZi4vhXTcMGCY3Yyb6w==
-----END CERTIFICATE-----`;

const codeSigning = new X509Certificate(CODE_SIGNING_PEM);
const serverAuth = new X509Certificate(SERVER_AUTH_PEM);
const thumbprintOf = (certificate: X509Certificate) =>
  certificate.fingerprint.replaceAll(':', '');
const NOW = new Date('2027-01-01T00:00:00Z');

function identityFor(
  certificate: X509Certificate,
  overrides: Partial<WindowsSigningIdentity> = {},
): WindowsSigningIdentity {
  return {
    schemaVersion: 1,
    signing: 'yubikey',
    spkiSha256: windowsCertificateSpkiSha256(certificate),
    publisherCommonName: 'HIPERSEND TECNOLOGIA INTERNET & SOFTWARES LTDA',
    certificateSha1: thumbprintOf(certificate),
    ...overrides,
  };
}

const stored = (certificate: X509Certificate, hasPrivateKey = true) => ({
  der: certificate.raw,
  hasPrivateKey,
});

describe('pinned Windows signing identity', () => {
  it('pins the public key of the YubiKey slot 9a key from the Yubico attestation', () => {
    expect(WINDOWS_SIGNING_IDENTITY).toMatchObject({
      signing: 'yubikey',
      spkiSha256: 'cc695904302f57c37532f709c25a9f25710bb04a2f23d1f89b42cf7430c4e3d0',
      publisherCommonName: 'HIPERSEND TECNOLOGIA INTERNET & SOFTWARES LTDA',
    });
    // A mesma chave pública exportada pelo `ykman piv keys export 9a`.
    const slotKey = createPublicKey(
      [
        '-----BEGIN PUBLIC KEY-----',
        'MHYwEAYHKoZIzj0CAQYFK4EEACIDYgAEql0T4p/nJIRPIPKJs0CCb0H65KeYh0+R',
        'ctl3Qd003cqRlL5XIO1MSCQ1M47P2SGNIjINMu3nYbtos7TueVidZE9kNm7Ypw5E',
        'sN0laBnqwrK5nHA5nuzcCF5AVmQwYBkz',
        '-----END PUBLIC KEY-----',
      ].join('\n'),
    );
    expect(slotKey.asymmetricKeyDetails?.namedCurve).toBe('secp384r1');
    expect(
      windowsCertificateSpkiSha256({ publicKey: slotKey } as X509Certificate),
    ).toBe(WINDOWS_SIGNING_IDENTITY.spkiSha256);
  });

  it('is the same file the receipt collector reads', () => {
    const json = JSON.parse(
      readFileSync(new URL('./windows-signing-identity.json', import.meta.url), 'utf8'),
    ) as unknown;
    expect(parseWindowsSigningIdentity(json)).toEqual(WINDOWS_SIGNING_IDENTITY);
  });

  it('rejects malformed identities and the eSigner certificate', () => {
    const valid = identityFor(codeSigning);
    for (const raw of [
      null,
      { ...valid, schemaVersion: 2 },
      { ...valid, signing: 'esigner' },
      { ...valid, spkiSha256: 'CC'.repeat(32) },
      { ...valid, publisherCommonName: ' HIPERSEND ' },
      { ...valid, certificateSha1: thumbprintOf(codeSigning).toLowerCase() },
      { ...valid, certificateSha1: ESIGNER_CERTIFICATE_SHA1 },
    ]) {
      expect(() => parseWindowsSigningIdentity(raw)).toThrow();
    }
    expect(parseWindowsSigningIdentity({ ...valid, certificateSha1: null }).certificateSha1)
      .toBeNull();
  });
});

describe('YubiKey signing opt-in', () => {
  const identity = identityFor(codeSigning);

  it('stays off without the explicit opt-in', () => {
    expect(windowsTokenSignerThumbprint({}, identity)).toBeUndefined();
  });

  it('signs with the pinned thumbprint', () => {
    expect(windowsTokenSignerThumbprint({ NEXUS_WINDOWS_YUBIKEY_SIGNING: '1' }, identity))
      .toBe(thumbprintOf(codeSigning));
  });

  it('refuses the retired eSigner-era opt-in, even beside the YubiKey one', () => {
    for (const value of ['1', '0', '']) {
      expect(() => windowsTokenSignerThumbprint({ NEXUS_WINDOWS_RELEASE_SIGNING: value }, identity))
        .toThrow(/retired/u);
    }
  });

  it('refuses a vague opt-in and a missing pinned certificate', () => {
    expect(() => windowsTokenSignerThumbprint({ NEXUS_WINDOWS_YUBIKEY_SIGNING: 'true' }, identity))
      .toThrow(/exactly "1"/u);
    expect(() => windowsTokenSignerThumbprint(
      { NEXUS_WINDOWS_YUBIKEY_SIGNING: '1' },
      { ...identity, certificateSha1: null },
    )).toThrow(/No YubiKey certificate is pinned/u);
  });

  it.each([
    'WINDOWS_CERTIFICATE_FILE',
    'WINDOWS_CERTIFICATE_PASSWORD',
    'WINDOWS_CERTIFICATE_SHA1',
    'WINDOWS_SIGN_WITH_PARAMS',
    'WINDOWS_SIGNTOOL_PATH',
    'WINDOWS_SIGN_HOOK_MODULE_PATH',
  ])('refuses %s, which @electron/windows-sign would honor over the YubiKey', (name) => {
    expect(() => windowsTokenSignerThumbprint(
      { NEXUS_WINDOWS_YUBIKEY_SIGNING: '1', [name]: '' },
      identity,
    )).toThrow(new RegExp(name, 'u'));
  });
});

describe('YubiKey certificate check', () => {
  it('accepts the pinned code signing certificate with its smart card key', () => {
    expect(() => assertWindowsTokenCertificate(stored(codeSigning), identityFor(codeSigning), NOW))
      .not.toThrow();
  });

  it('refuses a certificate over another key even when its thumbprint is pinned', () => {
    expect(() => assertWindowsTokenCertificate(
      stored(codeSigning),
      identityFor(codeSigning, { spkiSha256: 'cc'.repeat(32) }),
      NOW,
    )).toThrow(/not the YubiKey slot 9a key/u);
  });

  it('refuses another thumbprint, another publisher, a lapsed window and a missing key link', () => {
    const identity = identityFor(codeSigning);
    expect(() => assertWindowsTokenCertificate(
      stored(codeSigning),
      { ...identity, certificateSha1: 'A'.repeat(40) },
      NOW,
    )).toThrow(/thumbprint/u);
    expect(() => assertWindowsTokenCertificate(
      stored(codeSigning),
      { ...identity, publisherCommonName: 'OUTRA EMPRESA LTDA' },
      NOW,
    )).toThrow(/subject CN/u);
    expect(() => assertWindowsTokenCertificate(stored(codeSigning), identity, new Date('2026-01-01')))
      .toThrow(/valid only/u);
    expect(() => assertWindowsTokenCertificate(stored(codeSigning), identity, new Date('2127-01-01')))
      .toThrow(/valid only/u);
    expect(() => assertWindowsTokenCertificate(stored(codeSigning, false), identity, NOW))
      .toThrow(/YubiKey unplugged/u);
  });

  it('refuses a certificate that is not for code signing', () => {
    expect(() => assertWindowsTokenCertificate(stored(serverAuth), identityFor(serverAuth), NOW))
      .toThrow(/code signing/u);
  });

  it('checks the store before packaging and explains a missing YubiKey', async () => {
    const identity = identityFor(codeSigning);
    const read = vi.fn(async () => stored(codeSigning));
    await expect(assertWindowsTokenSigningReady(identity, read, NOW)).resolves.toBeUndefined();
    expect(read).toHaveBeenCalledWith(thumbprintOf(codeSigning));
    await expect(assertWindowsTokenSigningReady(identity, async () => undefined, NOW))
      .rejects.toThrow(/Plug in the YubiKey/u);
    await expect(assertWindowsTokenSigningReady({ ...identity, certificateSha1: null }, read, NOW))
      .rejects.toThrow(/No YubiKey certificate is pinned/u);
  });
});

describe('certificate store reader', () => {
  it('passes the thumbprint by environment and never through the command line', async () => {
    const run = vi.fn(async () => ({
      stdout: JSON.stringify({ der: codeSigning.raw.toString('base64'), hasPrivateKey: true }),
    }));
    const certificate = await readCurrentUserCertificate(thumbprintOf(codeSigning), run);
    expect(certificate?.der.equals(codeSigning.raw)).toBe(true);
    expect(certificate?.hasPrivateKey).toBe(true);
    const [file, args, options] = run.mock.calls[0] as unknown as [
      string,
      string[],
      { env: Record<string, string> },
    ];
    expect(file).toMatch(/WindowsPowerShell[\\/]v1\.0[\\/]powershell\.exe$/u);
    expect(args.join(' ')).not.toContain(thumbprintOf(codeSigning));
    expect(options.env.NEXUS_SIGNING_THUMBPRINT).toBe(thumbprintOf(codeSigning));
  });

  it('reports an absent certificate and rejects an unexpected answer', async () => {
    const absent = Object.assign(new Error('exit 3'), { code: 3 });
    await expect(readCurrentUserCertificate('A'.repeat(40), async () => { throw absent; }))
      .resolves.toBeUndefined();
    await expect(readCurrentUserCertificate('A'.repeat(40), async () => ({ stdout: '{}' })))
      .rejects.toThrow(/Unexpected/u);
  });

  it('runs on .NET alone, without the PowerShell 7 module path a Forge build inherits', async () => {
    const saved = process.env.PSModulePath;
    process.env.PSModulePath = 'C:\\Program Files\\PowerShell\\7\\Modules';
    try {
      const run = vi.fn(async () => ({
        stdout: JSON.stringify({ der: codeSigning.raw.toString('base64'), hasPrivateKey: true }),
      }));
      await readCurrentUserCertificate(thumbprintOf(codeSigning), run);
      const [, args, options] = run.mock.calls[0] as unknown as [
        string,
        string[],
        { env: Record<string, string | undefined> },
      ];
      expect(Object.keys(options.env).some((name) => name.toLowerCase() === 'psmodulepath'))
        .toBe(false);
      const script = Buffer.from(args.at(-1) ?? '', 'base64').toString('utf16le');
      expect(script).toContain('X509Store');
      expect(script).not.toMatch(/Cert:|Get-Item|ConvertTo-Json|SilentlyContinue/u);
    } finally {
      if (saved === undefined) delete process.env.PSModulePath;
      else process.env.PSModulePath = saved;
    }
  });

  // Reproduz o build real: npm aberto num terminal PowerShell 7 passa o
  // PSModulePath do 7 ao powershell.exe 5.1, que ficava sem o drive Cert:.
  const pwsh7Modules = 'C:\\Program Files\\PowerShell\\7\\Modules';
  const firstUserCertificate = process.platform === 'win32' && existsSync(pwsh7Modules)
    ? spawnSync(
        path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
        ['-NoProfile', '-NonInteractive', '-Command',
          "$s = [System.Security.Cryptography.X509Certificates.X509Store]::new('My', 'CurrentUser'); $s.Open('ReadOnly'); $c = @($s.Certificates); $s.Close(); if ($c.Count) { [Console]::Out.Write($c[0].Thumbprint) }"],
        { encoding: 'utf8', timeout: 30_000, windowsHide: true },
      ).stdout.trim()
    : '';
  it.runIf(/^[A-F0-9]{40}$/u.test(firstUserCertificate))(
    'finds a real user-store certificate under a PowerShell 7 module path',
    async () => {
      const saved = process.env.PSModulePath;
      process.env.PSModulePath = [
        'C:\\Users\\Administrador\\Documents\\PowerShell\\Modules',
        'C:\\Program Files\\PowerShell\\Modules',
        pwsh7Modules,
      ].join(';');
      try {
        const certificate = await readCurrentUserCertificate(firstUserCertificate);
        expect(certificate && new X509Certificate(certificate.der).fingerprint.replaceAll(':', ''))
          .toBe(firstUserCertificate);
      } finally {
        if (saved === undefined) delete process.env.PSModulePath;
        else process.env.PSModulePath = saved;
      }
    },
    60_000,
  );
});
