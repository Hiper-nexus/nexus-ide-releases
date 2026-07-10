import fs from 'node:fs';
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

/** Windows remains fail-closed until Nexus ships an enforceable provider. */
export function inspectSandboxCapability(
  platform: NodeJS.Platform,
  executableProbe: (candidate: string) => boolean = defaultExecutableProbe,
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
    return [doctorFinding(
      'sandbox',
      'blocker',
      'sandbox-unavailable-windows',
      'Provedor de sandbox seguro não está disponível no Windows.',
      'Execute agentes com isolamento em macOS/Linux, ou aguarde um provider Windows suportado; o runtime falha fechado.',
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
  return ids.length >= minRequired
    ? []
    : [doctorFinding(
        'independent-providers',
        'blocker',
        'insufficient-independent-providers',
        `Apenas ${ids.length} provedor(es) independente(s); mínimo ${minRequired} para high/critical.`,
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
