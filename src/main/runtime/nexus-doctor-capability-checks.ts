import fs from 'node:fs';
import { execFile, execFileSync } from 'node:child_process';
import type {
  IndependentProviderSnapshot,
  MultiPcBackendStatus,
  NexusDoctorFinding,
  NexusDoctorSeverity,
} from './nexus-doctor';
import { doctorFinding, doctorPathExists } from './nexus-doctor-support';

function defaultExecutableProbe(candidate: string): boolean {
  try {
    fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function defaultExecutableProbeAsync(candidate: string): Promise<boolean> {
  try {
    await fs.promises.access(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function defaultWindowsRuntimeProbeAsync(
  runtime: string,
  image: string,
): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(
      runtime,
      ['image', 'inspect', image],
      {
        timeout: 10_000,
        killSignal: 'SIGKILL',
        windowsHide: true,
        maxBuffer: 64 * 1024,
      },
      (error) => resolve(!error),
    );
  });
}

/** Windows remains fail-closed until Nexus ships an enforceable provider. */
export function inspectSandboxCapability(
  platform: NodeJS.Platform,
  executableProbe: (candidate: string) => boolean = defaultExecutableProbe,
  env: NodeJS.ProcessEnv = process.env,
  windowsRuntimeProbe: (runtime: string, image: string) => boolean = (runtime, image) => {
    try {
      execFileSync(runtime, ['image', 'inspect', image], { timeout: 10_000, stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  },
): NexusDoctorFinding[] {
  if (platform === 'darwin') {
    return doctorPathExists(executableProbe, '/usr/bin/sandbox-exec')
      ? []
      : [doctorFinding(
          'sandbox',
          'blocker',
          'seatbelt-unavailable',
          'sandbox-exec (Seatbelt) não está disponível ou não é executável neste macOS.',
          'Use um macOS com /usr/bin/sandbox-exec executável ou reinstale as ferramentas de sistema.',
        )];
  }
  if (platform === 'linux') {
    const candidates = ['/usr/bin/bwrap', '/bin/bwrap'];
    return candidates.some((candidate) => doctorPathExists(executableProbe, candidate))
      ? []
      : [doctorFinding(
          'sandbox',
          'blocker',
          'bubblewrap-unavailable',
          'Bubblewrap (bwrap) não está instalado ou não é executável; sandbox Linux fail-closed.',
          'Instale bubblewrap e garanta que /usr/bin/bwrap seja executável.',
        )];
  }
  if (platform === 'win32') {
    const runtime = env.NEXUS_SANDBOX_CONTAINER_RUNTIME?.trim();
    const image = env.NEXUS_SANDBOX_CONTAINER_IMAGE?.trim();
    const pinned = Boolean(image && /^[a-z0-9][a-z0-9./:_-]*@sha256:[a-f0-9]{64}$/i.test(image));
    if (runtime && image && pinned && executableProbe(runtime) && windowsRuntimeProbe(runtime, image)) return [];
    return [doctorFinding(
      'sandbox',
      'blocker',
      'sandbox-unavailable-windows',
      'Sandbox OCI segura não está configurada no Windows.',
      'Configure NEXUS_SANDBOX_CONTAINER_RUNTIME com Docker/Podman e NEXUS_SANDBOX_CONTAINER_IMAGE com uma imagem fixada por @sha256:digest.',
    )];
  }
  return [doctorFinding(
    'sandbox',
    'blocker',
    'sandbox-unavailable-platform',
    `Provedor de sandbox seguro indisponível em ${platform}.`,
    'Use darwin (Seatbelt) ou linux (Bubblewrap) para execução confinada de sensores/tools.',
  )];
}

export async function inspectSandboxCapabilityAsync(
  platform: NodeJS.Platform,
  executableProbe: (
    candidate: string,
  ) => boolean | Promise<boolean> = defaultExecutableProbeAsync,
  env: NodeJS.ProcessEnv = process.env,
  windowsRuntimeProbe: (
    runtime: string,
    image: string,
  ) => boolean | Promise<boolean> = defaultWindowsRuntimeProbeAsync,
): Promise<NexusDoctorFinding[]> {
  if (platform === 'darwin') {
    return (await executableProbe('/usr/bin/sandbox-exec'))
      ? []
      : [doctorFinding(
          'sandbox',
          'blocker',
          'seatbelt-unavailable',
          'sandbox-exec (Seatbelt) não está disponível ou não é executável neste macOS.',
          'Use um macOS com /usr/bin/sandbox-exec executável ou reinstale as ferramentas de sistema.',
        )];
  }
  if (platform === 'linux') {
    const available = await Promise.all(
      ['/usr/bin/bwrap', '/bin/bwrap'].map((candidate) =>
        executableProbe(candidate),
      ),
    );
    return available.some(Boolean)
      ? []
      : [doctorFinding(
          'sandbox',
          'blocker',
          'bubblewrap-unavailable',
          'Bubblewrap (bwrap) não está instalado ou não é executável; sandbox Linux fail-closed.',
          'Instale bubblewrap e garanta que /usr/bin/bwrap seja executável.',
        )];
  }
  if (platform === 'win32') {
    const runtime = env.NEXUS_SANDBOX_CONTAINER_RUNTIME?.trim();
    const image = env.NEXUS_SANDBOX_CONTAINER_IMAGE?.trim();
    const pinned = Boolean(
      image &&
        /^[a-z0-9][a-z0-9./:_-]*@sha256:[a-f0-9]{64}$/iu.test(image),
    );
    if (
      runtime &&
      image &&
      pinned &&
      (await executableProbe(runtime)) &&
      (await windowsRuntimeProbe(runtime, image))
    ) {
      return [];
    }
    return [doctorFinding(
      'sandbox',
      'blocker',
      'sandbox-unavailable-windows',
      'Sandbox OCI segura não está configurada no Windows.',
      'Configure NEXUS_SANDBOX_CONTAINER_RUNTIME com Docker/Podman e NEXUS_SANDBOX_CONTAINER_IMAGE com uma imagem fixada por @sha256:digest.',
    )];
  }
  return [doctorFinding(
    'sandbox',
    'blocker',
    'sandbox-unavailable-platform',
    `Provedor de sandbox seguro indisponível em ${platform}.`,
    'Use darwin (Seatbelt) ou linux (Bubblewrap) para execução confinada de sensores/tools.',
  )];
}

function eligibleProviderIds(
  providers: readonly IndependentProviderSnapshot[],
): readonly string[] {
  return Object.freeze([
    ...new Set(
      providers
        .filter(
          (provider) =>
            provider.enabled &&
            provider.installed &&
            provider.kind === 'cli-pty' &&
            provider.authStrategy !== 'login-needed' &&
            provider.readOnlyCapable === true,
        )
        .map((provider) => provider.adapterId),
    ),
  ].sort());
}

export function inspectIndependentProviders(
  providers: readonly IndependentProviderSnapshot[] | undefined,
  minRequired: number,
): NexusDoctorFinding[] {
  if (!providers) {
    return [doctorFinding(
      'independent-providers',
      'blocker',
      'providers-probe-skipped',
      'Lista de provedores não foi injetada; quorum independente não verificado.',
      'Injete listProviderSettings (ou snapshot equivalente) no Nexus Doctor.',
    )];
  }
  const ids = eligibleProviderIds(providers);
  if (ids.length === 0) {
    return [doctorFinding(
      'independent-providers',
      'blocker',
      'no-independent-providers',
      'Nenhum provedor CLI instalado, habilitado, autenticado e confinável para review independente.',
      'Instale e autentique três CLIs distintos para suportar autor + dois reviewers em risco critical.',
      )];
  }
  if (ids.length === 1) {
    return [doctorFinding(
      'independent-providers',
      'blocker',
      'insufficient-independent-providers',
      'Apenas um provedor confinável; não há como garantir autor e reviewer de vendors distintos.',
      'Instale/autentique ao menos dois provedores CLI distintos para review independente.',
      ids,
    )];
  }
  return ids.length >= minRequired
    ? []
    : [doctorFinding(
        'independent-providers',
        // Dois provedores confináveis já permitem autor + reviewer diferente;
        // acima disso, o mínimo maior é preferência do Review Council.
        'warning',
        'insufficient-independent-providers',
        `Apenas ${ids.length} provedor(es) independente(s); recomendado ${minRequired} para o Review Council em risco high/critical.`,
        'Instale/autentique provedores CLI adicionais de vendors distintos para o Review Council.',
        ids,
      )];
}

function missingBackendFinding(
  code: string,
  message: string,
  remediation: string,
  severity: NexusDoctorSeverity,
): NexusDoctorFinding {
  return doctorFinding(
    'multi-pc-backend',
    severity,
    code,
    message,
    remediation,
  );
}

export function inspectMultiPcBackend(
  status: MultiPcBackendStatus | undefined,
): NexusDoctorFinding[] {
  if (!status) {
    return [missingBackendFinding(
      'multi-pc-status-unknown',
      'Status do backend multi-PC não informado.',
      'Passe leaseBackendConfigured/syncBackendConfigured ao Doctor.',
      'blocker',
    )];
  }
  const isSharedRequired = status.requireSharedExecution !== false;
  const severity: NexusDoctorSeverity = isSharedRequired ? 'blocker' : 'warning';
  const findings: NexusDoctorFinding[] = [];
  if (!status.leaseBackendConfigured) {
    findings.push(missingBackendFinding(
      'lease-backend-unconfigured',
      'Backend remoto de lease multi-PC não configurado.',
      isSharedRequired
        ? 'Configure o LeaseBackend remoto antes de habilitar cron shared entre máquinas.'
        : 'Opcional em single-device: jobs shared permanecem fail-closed até haver LeaseBackend.',
      severity,
    ));
  }
  if (!status.syncBackendConfigured) {
    findings.push(missingBackendFinding(
      'sync-backend-unconfigured',
      'SyncBackend multi-PC não configurado.',
      'Configure um backend de schedules/metadados com compare-and-swap e conflitos explícitos.',
      severity,
    ));
  }
  return findings;
}
