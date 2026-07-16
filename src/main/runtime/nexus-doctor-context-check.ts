import type {
  ContextDoctorSnapshot,
  NexusDoctorFinding,
} from './nexus-doctor';
import {
  doctorErrorMessage,
  doctorFinding,
} from './nexus-doctor-support';

const CONTEXT_REMEDIATION: Readonly<Record<string, string>> = Object.freeze({
  'missing-business-context':
    'Documente project-overview, business-model e domain-glossary em .context/docs/ a partir de fontes versionadas.',
  'missing-technical-context':
    'Documente architecture.md e testing.md em .context/docs/.',
  'missing-structured-invariants':
    'Proponha um draft para .context/nexus/invariants/<slug>.json ' +
    '({"schemaVersion":1,"facts":[…]}, kind "observed", category "invariant") ' +
    'derivado de fontes REAIS (schema, testes, configs) e aprove via revisão ' +
    'independente — evidência observada, nunca regra de negócio inventada.',
  'missing-policy':
    'Crie .context/config/policy.json (scaffold via ensureContextScaffold) e versionar no Git.',
  'invalid-policy':
    'Corrija .context/config/policy.json conforme o schema enforce do Context Doctor.',
  'missing-sensors':
    'Crie .context/config/sensors.json com sensores declarativos (typecheck e unit no mínimo).',
  'invalid-sensors':
    'Corrija o schema de .context/config/sensors.json (sem shell livre, network:false).',
  'missing-required-sensors':
    'Inclua os sensores obrigatórios typecheck e unit em .context/config/sensors.json.',
  'missing-context-attestation':
    'Obtenha revisão independente e grave attestations vinculando docs/fatos às fontes.',
  'invalid-context-attestation':
    'Revalide ou reescreva attestations cujo vínculo com as fontes foi perdido.',
  'invalid-context':
    'Corrija o corpus .context/ até o ingestor validar sem erro.',
  'context-conflict':
    'Resolva conflitos de fatos/símbolos no Truth Graph antes de executar missões.',
});

function mapContextDiagnostic(
  severity: 'blocker' | 'warning',
  item: ContextDoctorSnapshot['blockers'][number],
): NexusDoctorFinding {
  const fallback = severity === 'blocker'
    ? 'Corrija o bloqueador reportado pelo Context Doctor e rode o doctor novamente.'
    : 'Revise o aviso do Context Doctor; não bloqueia se ready=true.';
  return doctorFinding(
    'context-doctor',
    severity,
    item.code,
    item.message,
    CONTEXT_REMEDIATION[item.code] ?? fallback,
    item.details,
  );
}

function missingContextProbe(): NexusDoctorFinding[] {
  return [
    doctorFinding(
      'context-doctor',
      'blocker',
      'context-doctor-skipped',
      'Context Doctor não foi injetado; readiness de contexto não foi verificado.',
      'Injete inspectContextReadiness do módulo context-doctor no bootstrap do Nexus Doctor.',
    ),
  ];
}

function failedContextProbe(error?: unknown): NexusDoctorFinding[] {
  return [
    doctorFinding(
      'context-doctor',
      'blocker',
      'context-doctor-failed',
      'Context Doctor lançou erro durante a inspeção.',
      'Corrija o corpus/config de .context/ até inspectContextReadiness completar.',
      error === undefined ? undefined : [doctorErrorMessage(error)],
    ),
  ];
}

export function inspectContextDoctor(
  snapshot: ContextDoctorSnapshot | undefined,
  probeConfigured: boolean,
  probeError?: unknown,
): NexusDoctorFinding[] {
  if (!probeConfigured) return missingContextProbe();
  if (!snapshot) return failedContextProbe(probeError);

  try {
    const findings = [
      ...snapshot.blockers.map((item) => mapContextDiagnostic('blocker', item)),
      ...snapshot.warnings.map((item) => mapContextDiagnostic('warning', item)),
    ];
    if (!snapshot.ready && findings.length === 0) {
      findings.push(
        doctorFinding(
          'context-doctor',
          'blocker',
          'context-not-ready',
          'Context Doctor reportou ready=false sem diagnósticos.',
          'Atualize o Context Doctor ou reexecute com corpus completo.',
        ),
      );
    }
    return findings;
  } catch (error) {
    return failedContextProbe(error);
  }
}
