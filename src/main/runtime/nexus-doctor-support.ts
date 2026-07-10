import type {
  NexusDoctorCheckId,
  NexusDoctorCheckResult,
  NexusDoctorFinding,
  NexusDoctorSeverity,
} from './nexus-doctor';

export function freezeDoctorFinding(
  value: NexusDoctorFinding,
): NexusDoctorFinding {
  return Object.freeze({
    ...value,
    details: value.details ? Object.freeze([...value.details]) : undefined,
  });
}

export function doctorFinding(
  check: NexusDoctorCheckId,
  severity: NexusDoctorSeverity,
  code: string,
  message: string,
  remediation: string,
  details?: readonly string[],
): NexusDoctorFinding {
  return freezeDoctorFinding({
    check,
    severity,
    code,
    message,
    remediation,
    details,
  });
}

export function doctorCheckResult(
  check: NexusDoctorCheckId,
  findings: readonly NexusDoctorFinding[],
): NexusDoctorCheckResult {
  return Object.freeze({
    check,
    ok: findings.every((item) => item.severity !== 'blocker'),
    findings: Object.freeze(findings.map(freezeDoctorFinding)),
  });
}

export function doctorErrorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 4_096);
}

export function doctorPathExists(
  probe: (candidate: string) => boolean,
  candidate: string,
): boolean {
  try {
    return probe(candidate);
  } catch {
    return false;
  }
}
