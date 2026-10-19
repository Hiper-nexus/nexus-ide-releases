import { execFile } from 'node:child_process';
import { X509Certificate, createHash } from 'node:crypto';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import windowsSigner from '../scripts/windows-signer/client.cjs';
import pinnedIdentity from './windows-signing-identity.json';

/**
 * Assinatura Authenticode do Windows por token de hardware (decisão do operador
 * em 19/10/2026). O YubiKey 5C NFC FIPS (série 25700086) substitui o eSigner da
 * SSL.com, que cobrava por assinatura e saiu em 05/10. A chave ECC P-384 nasceu
 * no slot PIV 9a e não sai dele (a atestação da Yubico foi aceita no pedido
 * co-f01l53ldh43). Com o YubiKey espetado, o Windows propaga o certificado OV
 * da HIPERSEND para `Cert:\CurrentUser\My`, ligado à chave do cartão.
 *
 * O Windows pede o PIN a cada PROCESSO que usa a chave, e o Squirrel abre um
 * signtool por executável: eram 5 janelas por build (19/10). Por isso a build não
 * chama o SignTool: o @electron/windows-sign (packager e Squirrel) usa o hook
 * `scripts/windows-signer/client.cjs`, que pede cada assinatura ao agente de
 * `scripts/windows-signer/agent.cjs`. O agente segura a chave num só processo:
 * uma janela de PIN quando sobe e nenhuma enquanto vive (24 h por padrão,
 * `NEXUS_WINDOWS_SIGNER_HOURS` de 0 = só este build a 168 = uma semana).
 *
 * `windows-signing-identity.json` é a fonte única da identidade, lida também
 * pelo coletor do recibo (PowerShell) e pelo publicador:
 * - `spkiSha256`: SHA-256 do SubjectPublicKeyInfo da chave do slot 9a,
 *   conferido contra a atestação. Só o YubiKey assina com ela; certificado com
 *   outra chave (o RSA do eSigner, um PFX) é recusado mesmo com o thumbprint
 *   fixado.
 * - `certificateSha1`: thumbprint do certificado que o SSL.com emitiu para essa
 *   chave. `null` enquanto ele não existe: o modo recusa em vez de assinar.
 */
export interface WindowsSigningIdentity {
  schemaVersion: 1;
  signing: 'yubikey';
  spkiSha256: string;
  publisherCommonName: string;
  certificateSha1: string | null;
}

export const WINDOWS_TOKEN_SIGNING_ENV = 'NEXUS_WINDOWS_YUBIKEY_SIGNING';

/** Certificado RSA do eSigner, aposentado em 05/10/2026: nunca volta a assinar. */
export const ESIGNER_CERTIFICATE_SHA1 = 'E44D98FF840B1DF78D87F6768D177B5719952CAB';

const CODE_SIGNING_EKU = '1.3.6.1.5.5.7.3.3';

/**
 * O @electron/windows-sign lê estas variáveis por baixo das opções do Forge:
 * `/f` + `/p` de um PFX, outro signtool ou um hook no lugar dele. Qualquer uma
 * assinaria com outra coisa que não o YubiKey. `NEXUS_WINDOWS_SIGNER_DIR` mandaria
 * o hook a outro agente.
 */
const SIGNER_OVERRIDE_ENV = [
  'WINDOWS_CERTIFICATE_FILE',
  'WINDOWS_CERTIFICATE_PASSWORD',
  'WINDOWS_CERTIFICATE_SHA1',
  'WINDOWS_SIGN_WITH_PARAMS',
  'WINDOWS_SIGNTOOL_PATH',
  'WINDOWS_SIGN_HOOK_MODULE_PATH',
  'NEXUS_WINDOWS_SIGNER_DIR',
] as const;

export function parseWindowsSigningIdentity(raw: unknown): WindowsSigningIdentity {
  const value = (raw ?? {}) as Record<string, unknown>;
  const { spkiSha256, publisherCommonName, certificateSha1 } = value;
  if (
    value.schemaVersion !== 1 ||
    value.signing !== 'yubikey' ||
    typeof spkiSha256 !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(spkiSha256) ||
    typeof publisherCommonName !== 'string' ||
    publisherCommonName.trim() !== publisherCommonName ||
    publisherCommonName === ''
  ) {
    throw new Error('build/windows-signing-identity.json is malformed.');
  }
  if (certificateSha1 !== null) {
    if (typeof certificateSha1 !== 'string' || !/^[A-F0-9]{40}$/u.test(certificateSha1)) {
      throw new Error(
        'build/windows-signing-identity.json certificateSha1 must be null or 40 uppercase hexadecimal characters.',
      );
    }
    if (certificateSha1 === ESIGNER_CERTIFICATE_SHA1) {
      throw new Error(
        'build/windows-signing-identity.json pins the SSL.com eSigner certificate, which bills per signature and was removed on 2026-10-05.',
      );
    }
  }
  return {
    schemaVersion: 1,
    signing: 'yubikey',
    spkiSha256,
    publisherCommonName,
    certificateSha1,
  };
}

export const WINDOWS_SIGNING_IDENTITY = parseWindowsSigningIdentity(pinnedIdentity);

/**
 * Thumbprint com que a build assina, ou `undefined` sem o opt-in. Falha fechada:
 * a variável da era eSigner, valores ambíguos e a falta de certificado fixado
 * recusam antes de empacotar.
 */
export function windowsTokenSignerThumbprint(
  environment: Readonly<Record<string, string | undefined>>,
  identity: WindowsSigningIdentity = WINDOWS_SIGNING_IDENTITY,
): string | undefined {
  if (environment.NEXUS_WINDOWS_RELEASE_SIGNING !== undefined) {
    throw new Error(
      `NEXUS_WINDOWS_RELEASE_SIGNING was retired with the SSL.com eSigner on 2026-10-05. Windows releases are signed only by the YubiKey: set ${WINDOWS_TOKEN_SIGNING_ENV}=1 (docs/windows-signing/YUBIKEY.md) or build unsigned.`,
    );
  }
  const mode = environment[WINDOWS_TOKEN_SIGNING_ENV];
  if (mode === undefined) return undefined;
  if (mode !== '1') {
    throw new Error(`${WINDOWS_TOKEN_SIGNING_ENV} must be exactly "1".`);
  }
  const overrides = SIGNER_OVERRIDE_ENV.filter((name) => environment[name] !== undefined);
  if (overrides.length > 0) {
    throw new Error(
      `YubiKey signing refuses ${overrides.join(', ')}: @electron/windows-sign would sign with another certificate or tool. Remove them from the environment.`,
    );
  }
  if (!identity.certificateSha1) {
    throw new Error(
      'No YubiKey certificate is pinned yet: import the SSL.com certificate into PIV slot 9a and pin its thumbprint in build/windows-signing-identity.json (docs/windows-signing/YUBIKEY.md).',
    );
  }
  return identity.certificateSha1;
}

export interface WindowsStoreCertificate {
  der: Buffer;
  /** O Windows tem a ligação do certificado com uma chave privada (a do cartão). */
  hasPrivateKey: boolean;
}

export function windowsCertificateSpkiSha256(certificate: X509Certificate): string {
  return createHash('sha256')
    .update(certificate.publicKey.export({ type: 'spki', format: 'der' }))
    .digest('hex');
}

/** Confere o certificado que a loja do Windows vai entregar ao SignTool. */
export function assertWindowsTokenCertificate(
  certificate: WindowsStoreCertificate,
  identity: WindowsSigningIdentity,
  now: Date = new Date(),
): void {
  const x509 = new X509Certificate(certificate.der);
  const thumbprint = x509.fingerprint.replaceAll(':', '').toUpperCase();
  const commonName = x509.subject
    .split('\n')
    .find((line) => line.startsWith('CN='))
    ?.slice('CN='.length);
  const problems: string[] = [];
  if (thumbprint !== identity.certificateSha1) {
    problems.push(`thumbprint is not the pinned ${identity.certificateSha1 ?? '(none)'}`);
  }
  if (windowsCertificateSpkiSha256(x509) !== identity.spkiSha256) {
    problems.push('its public key is not the YubiKey slot 9a key');
  }
  if (commonName !== identity.publisherCommonName) {
    problems.push(`subject CN is not ${identity.publisherCommonName}`);
  }
  if (!x509.keyUsage?.includes(CODE_SIGNING_EKU)) {
    problems.push('it lacks the code signing extended key usage');
  }
  const time = now.getTime();
  if (time < Date.parse(x509.validFrom) || time > Date.parse(x509.validTo)) {
    problems.push(`it is valid only from ${x509.validFrom} to ${x509.validTo}`);
  }
  if (!certificate.hasPrivateKey) {
    problems.push('Windows has no private key for it (YubiKey unplugged or certificate not propagated)');
  }
  if (problems.length > 0) {
    throw new Error(`Windows signing certificate ${thumbprint} refused: ${problems.join('; ')}.`);
  }
}

const execFileAsync = promisify(execFile);

/**
 * Lê o certificado sem tocar na chave: nenhum PIN é pedido aqui. Só .NET
 * (`X509Store`), sem módulo do PowerShell: aberto de um PowerShell 7, o 5.1 herda
 * o `PSModulePath` dele e fica sem o drive `Cert:` ("Não existe uma unidade com o
 * nome 'Cert'"), o que o `Get-Item -ErrorAction SilentlyContinue` antigo virava em
 * "certificado ausente". Erro de leitura agora sai como erro (código 1).
 */
const READ_CERTIFICATE_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "$store = [System.Security.Cryptography.X509Certificates.X509Store]::new('My', 'CurrentUser')",
  "$store.Open('ReadOnly')",
  "try { $found = $store.Certificates.Find('FindByThumbprint', $env:NEXUS_SIGNING_THUMBPRINT, $false) } finally { $store.Close() }",
  'if ($found.Count -eq 0) { exit 3 }',
  '$certificate = $found[0]',
  "[Console]::Out.Write('{\"der\":\"' + [Convert]::ToBase64String($certificate.RawData) + '\",\"hasPrivateKey\":' + $certificate.HasPrivateKey.ToString().ToLowerInvariant() + '}')",
].join('\n');

type ExecFile = (
  file: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; timeout: number; windowsHide: boolean },
) => Promise<{ stdout: string }>;

export async function readCurrentUserCertificate(
  thumbprint: string,
  run: ExecFile = execFileAsync,
): Promise<WindowsStoreCertificate | undefined> {
  const powershell = path.join(
    process.env.SystemRoot ?? 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  );
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => name.toLowerCase() !== 'psmodulepath'),
  );
  let stdout: string;
  try {
    ({ stdout } = await run(
      powershell,
      [
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        Buffer.from(READ_CERTIFICATE_SCRIPT, 'utf16le').toString('base64'),
      ],
      {
        env: { ...environment, NEXUS_SIGNING_THUMBPRINT: thumbprint },
        timeout: 30_000,
        windowsHide: true,
      },
    ));
  } catch (error) {
    if ((error as { code?: unknown }).code === 3) return undefined;
    throw error;
  }
  const parsed = JSON.parse(stdout) as { der?: unknown; hasPrivateKey?: unknown };
  if (typeof parsed.der !== 'string' || typeof parsed.hasPrivateKey !== 'boolean') {
    throw new Error('Unexpected certificate store answer.');
  }
  return { der: Buffer.from(parsed.der, 'base64'), hasPrivateKey: parsed.hasPrivateKey };
}

/**
 * Checagem antes de empacotar: certificado na loja do usuário, com a chave do
 * YubiKey, o nome da HIPERSEND, uso de assinatura de código e dentro da
 * validade. Sem ela, um certificado errado só apareceria no recibo, depois de
 * a build inteira ter sido assinada.
 */
export async function assertWindowsTokenSigningReady(
  identity: WindowsSigningIdentity = WINDOWS_SIGNING_IDENTITY,
  readCertificate: (thumbprint: string) => Promise<WindowsStoreCertificate | undefined> =
    readCurrentUserCertificate,
  now: Date = new Date(),
): Promise<void> {
  const thumbprint = identity.certificateSha1;
  if (!thumbprint) {
    throw new Error('No YubiKey certificate is pinned in build/windows-signing-identity.json.');
  }
  const certificate = await readCertificate(thumbprint);
  if (!certificate) {
    throw new Error(
      `Windows signing certificate ${thumbprint} is not in Cert:\\CurrentUser\\My. Plug in the YubiKey (serial 25700086) and wait for Windows to propagate its certificate.`,
    );
  }
  assertWindowsTokenCertificate(certificate, identity, now);
}

/** Módulo que o @electron/windows-sign carrega no lugar do SignTool (caminho absoluto: o Squirrel roda em outra pasta). */
export const WINDOWS_SIGNER_HOOK_MODULE = path.resolve('scripts', 'windows-signer', 'client.cjs');

export type WindowsSignerClient = Pick<
  typeof windowsSigner,
  'ensureAgent' | 'verifyFile' | 'failures' | 'stopAgent'
>;

/** Horas de vida do agente: 24 por padrão, 0 = só este build, até 168 (uma semana). */
export function windowsTokenSignerHours(
  environment: Readonly<Record<string, string | undefined>>,
): number {
  return windowsSigner.parseAgentHours(environment.NEXUS_WINDOWS_SIGNER_HOURS);
}

/**
 * Antes do primeiro arquivo assinado: reaproveita o agente destrancado (nenhum
 * PIN) ou sobe um novo (a janela de PIN do Windows, uma vez), confere que o
 * certificado que ele segura é o fixado e passa ao hook, pelo ambiente que o
 * Squirrel herda, o checkout cujo `out\` pode ser assinado e o carimbo.
 */
export async function prepareWindowsTokenSigner({
  environment = process.env,
  identity = WINDOWS_SIGNING_IDENTITY,
  timestampServer,
  checkoutRoot = process.cwd(),
  client = windowsSigner,
  now = new Date(),
}: {
  environment?: NodeJS.ProcessEnv;
  identity?: WindowsSigningIdentity;
  timestampServer: string;
  checkoutRoot?: string;
  client?: WindowsSignerClient;
  now?: Date;
}): Promise<{ started: boolean; expiresAt: number | null }> {
  const thumbprint = identity.certificateSha1;
  if (!thumbprint) {
    throw new Error('No YubiKey certificate is pinned in build/windows-signing-identity.json.');
  }
  const hours = windowsTokenSignerHours(environment);
  const status = await client.ensureAgent({
    thumbprint,
    spkiSha256: identity.spkiSha256,
    hours,
    parentPid: hours === 0 ? process.pid : undefined,
  });
  if (!status.unlocked || !status.certificate) {
    throw new Error('The YubiKey signing agent is not unlocked.');
  }
  assertWindowsTokenCertificate(
    { der: Buffer.from(status.certificate, 'base64'), hasPrivateKey: true },
    identity,
    now,
  );
  environment.NEXUS_WINDOWS_SIGNER_CHECKOUT = path.resolve(checkoutRoot);
  environment.NEXUS_WINDOWS_SIGNER_TIMESTAMP = timestampServer;
  return { started: status.started, expiresAt: status.expiresAt ?? null };
}

/** O que o @electron/windows-sign tentaria assinar (dist/cjs/files.js). */
const WINDOWS_SIGN_CANDIDATE =
  /\.(exe|dll|sys|efi|scr|node|msi|appx|appxbundle|msix|msixbundle|cat|cab|xap|vbs|wsf|ps1)$/iu;

export function listWindowsSignCandidates(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...listWindowsSignCandidates(full));
    else if (entry.isFile() && WINDOWS_SIGN_CANDIDATE.test(entry.name)) found.push(full);
  }
  return found;
}

/**
 * O hook do @electron/windows-sign tem o erro engolido pela biblioteca: sem esta
 * conferência um arquivo recusado sairia sem assinatura num pacote "pronto".
 * Falha registrada pelo hook recusa; depois cada executável do pacote é
 * conferido pelo agente (assinatura válida e do certificado fixado).
 */
export async function assertWindowsPackageSigned(
  outputPaths: readonly string[],
  client: WindowsSignerClient = windowsSigner,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  assertNoWindowsSigningFailures(client);
  let verified = 0;
  for (const outputPath of outputPaths) {
    for (const file of listWindowsSignCandidates(outputPath)) {
      await client.verifyFile(file, environment);
      verified += 1;
    }
  }
  if (verified === 0) throw new Error('The Windows package has no executable to verify.');
  return verified;
}

export function assertNoWindowsSigningFailures(client: WindowsSignerClient = windowsSigner): void {
  const failed = client.failures();
  if (failed.length > 0) {
    throw new Error(
      `YubiKey signing failed for ${failed.length} file(s): ${failed.map(({ file, error }) => `${file} (${error})`).join('; ')}`,
    );
  }
}

/** Fim do make: o agente de build único (`NEXUS_WINDOWS_SIGNER_HOURS=0`) sai junto. */
export async function finishWindowsTokenSigning(
  environment: Readonly<Record<string, string | undefined>> = process.env,
  client: WindowsSignerClient = windowsSigner,
): Promise<void> {
  assertNoWindowsSigningFailures(client);
  if (windowsTokenSignerHours(environment) === 0) await client.stopAgent();
}
