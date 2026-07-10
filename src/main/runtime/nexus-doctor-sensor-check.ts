import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { ProjectExecutionScope } from '../../shared/types';
import type { NexusDoctorFinding } from './nexus-doctor';
import { doctorErrorMessage, doctorFinding } from './nexus-doctor-support';

const SENSORS_RELATIVE_PATH = '.context/config/sensors.json';
const SENSOR_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const MAX_SENSOR_TIMEOUT_MS = 15 * 60_000;

const sensorConfigShapeSchema = z.object({
  schemaVersion: z.literal(1),
  sensors: z.array(z.unknown()).max(256),
}).strict();

const sensorDefinitionSchema = z.object({
  id: z.string().regex(SENSOR_ID_PATTERN),
  command: z
    .array(z.string().min(1).max(65_536).refine((value) => !value.includes('\0')))
    .min(1)
    .max(1_024),
  timeoutMs: z.number().int().min(1).max(MAX_SENSOR_TIMEOUT_MS),
  network: z.literal(false),
  cwd: z.string().max(4_096).optional(),
}).strict();

export interface SensorCheckDependencies {
  readonly exists: (candidate: string) => boolean;
  readonly readFile: typeof fs.readFileSync;
  readonly requiredSensorIds: readonly string[];
  readonly contextSensorIds?: readonly string[];
}

function invalidShape(details: readonly string[]): NexusDoctorFinding {
  return doctorFinding(
    'sensors',
    'blocker',
    'invalid-sensors-shape',
    'sensors.json não usa schemaVersion 1 com um array sensors.',
    'Use o schema versionado do Context Doctor (schemaVersion:1, sensors:[{id,command,timeoutMs,network:false}]).',
    details,
  );
}

function parseSensorIds(values: readonly unknown[]): {
  readonly ids: readonly string[];
  readonly errors: readonly string[];
} {
  const ids: string[] = [];
  const errors: string[] = [];
  values.forEach((value, index) => {
    const parsed = sensorDefinitionSchema.safeParse(value);
    if (!parsed.success) {
      errors.push(
        ...parsed.error.issues.map(
          (issue) => `sensors[${index}]${issue.path.length ? `.${issue.path.join('.')}` : ''}: ${issue.message}`,
        ),
      );
      return;
    }
    ids.push(parsed.data.id);
  });
  if (new Set(ids).size !== ids.length) errors.push('sensor IDs must be unique');
  return { ids: Object.freeze(ids), errors: Object.freeze(errors) };
}

function missingRequiredSensors(
  ids: readonly string[],
  required: readonly string[],
): NexusDoctorFinding[] {
  const missing = required.filter((id) => !ids.includes(id));
  return missing.length === 0
    ? []
    : [doctorFinding(
        'sensors',
        'blocker',
        'missing-required-sensors',
        'Sensores mínimos não configurados.',
        'Adicione os sensores obrigatórios em .context/config/sensors.json.',
        missing,
      )];
}

function sensorDrift(
  ids: readonly string[],
  contextIds: readonly string[] | undefined,
): NexusDoctorFinding[] {
  if (!contextIds || contextIds.length === 0) return [];
  const disk = new Set(ids);
  const context = new Set(contextIds);
  const drift = [
    ...ids.filter((id) => !context.has(id)),
    ...contextIds.filter((id) => !disk.has(id)),
  ];
  return drift.length === 0
    ? []
    : [doctorFinding(
        'sensors',
        'warning',
        'sensor-set-drift',
        'Conjunto de sensores no disco diverge do snapshot do Context Doctor.',
        'Reexecute o Context Doctor após salvar sensors.json e confirme o hash de config.',
        drift,
      )];
}

export function inspectSensors(
  scope: ProjectExecutionScope,
  dependencies: SensorCheckDependencies,
): NexusDoctorFinding[] {
  const sensorPath = path.join(scope.rootRealPath, SENSORS_RELATIVE_PATH);
  if (!dependencies.exists(sensorPath)) {
    return [doctorFinding(
      'sensors',
      'blocker',
      'missing-sensors-config',
      'Configuração declarativa de sensores ausente.',
      'Crie .context/config/sensors.json com typecheck e unit (network:false, timeout limitado).',
    )];
  }

  try {
    const shape = sensorConfigShapeSchema.safeParse(
      JSON.parse(dependencies.readFile(sensorPath, 'utf8')),
    );
    if (!shape.success) {
      return [invalidShape(shape.error.issues.map((issue) => issue.message))];
    }
    const parsed = parseSensorIds(shape.data.sensors);
    const findings = parsed.errors.length === 0
      ? []
      : [doctorFinding(
          'sensors',
          'blocker',
          'invalid-sensor-definition',
          'Uma ou mais definições de sensor não são confináveis.',
          'Corrija command, timeoutMs e network:false em todos os sensores.',
          parsed.errors,
        )];
    return [
      ...findings,
      ...missingRequiredSensors(parsed.ids, dependencies.requiredSensorIds),
      ...sensorDrift(parsed.ids, dependencies.contextSensorIds),
    ];
  } catch (error) {
    return [doctorFinding(
      'sensors',
      'blocker',
      'sensors-unreadable',
      'Não foi possível ler/validar .context/config/sensors.json.',
      'Corrija JSON e permissões de .context/config/sensors.json.',
      [doctorErrorMessage(error)],
    )];
  }
}
