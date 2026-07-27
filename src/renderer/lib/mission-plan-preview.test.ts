import { describe, expect, it } from 'vitest';
import type { Squad, SquadAgent } from '../../shared/orch-types';
import type { AdapterInfo } from '../../shared/types';
import type { RichModelMetadataView } from '../../shared/model-metadata-types';
import {
  buildRosterCostPreview,
  forecastMissionWaves,
  missionReviewP0P3Status,
  modelMetadataKey,
} from './mission-plan-preview';

const roster: SquadAgent[] = [
  {
    id: 'orch',
    agentName: 'Maestro',
    category: 'orchestrator',
    cli: 'claude',
    model: 'claude-sonnet',
  },
  {
    id: 'dev',
    agentName: 'Implementador',
    category: 'executor',
    cli: 'codex',
    model: 'gpt-worker',
  },
];

const adapters: AdapterInfo[] = [
  {
    id: 'claude',
    kind: 'cli-pty',
    label: 'Claude',
    icon: 'C',
    models: { list: ['claude-sonnet'], default: 'claude-sonnet' },
    installed: true,
    orchestratorCapable: true,
    installCommand: '',
    idleTimeoutMs: 1_000,
  },
  {
    id: 'codex',
    kind: 'cli-pty',
    label: 'Codex',
    icon: 'X',
    models: { list: ['gpt-worker'], default: 'gpt-worker' },
    installed: true,
    orchestratorCapable: true,
    installCommand: '',
    idleTimeoutMs: 1_000,
  },
];

function metadata(
  id: string,
  input: number,
  output: number,
): RichModelMetadataView {
  return {
    id,
    ompProvider: 'fixture',
    cost: { input, output },
  };
}

describe('mission plan preview', () => {
  it('shows a bounded unit-price range without presenting plan limits as billing', () => {
    const preview = buildRosterCostPreview({
      roster,
      adapters,
      metadataByKey: {
        [modelMetadataKey('claude', 'claude-sonnet')]: metadata(
          'claude-sonnet',
          2,
          10,
        ),
        [modelMetadataKey('codex', 'gpt-worker')]: metadata(
          'gpt-worker',
          1,
          8,
        ),
      },
    });

    expect(preview.complete).toBe(true);
    expect(preview.lines).toHaveLength(2);
    expect(preview.lines[0]).toMatchObject({
      agentName: 'Maestro',
      modelId: 'claude-sonnet',
      rateLabel: '$2 entrada / $10 saída por 1M tokens',
    });
    expect(preview.lines[1]?.estimateLabel).toContain(
      'indisponível antes do plano',
    );
    expect(preview.totalLabel).toContain('$1–$10 por 1M tokens');
    expect(preview.totalLabel).toContain('Estimativa total indisponível');
    expect(preview.caveat).toContain('controles operacionais');
    expect(preview.caveat).toContain('cobrança do provedor');
    expect(preview.caveat).not.toContain('ledger');
  });

  it('marks price and total estimate unavailable instead of inventing a value', () => {
    const preview = buildRosterCostPreview({
      roster,
      adapters,
      metadataByKey: {
        [modelMetadataKey('claude', 'claude-sonnet')]: metadata(
          'claude-sonnet',
          2,
          10,
        ),
        [modelMetadataKey('codex', 'gpt-worker')]: null,
      },
    });

    expect(preview.complete).toBe(false);
    expect(preview.lines[1]?.rateLabel).toContain('indisponível');
    expect(preview.lines[1]?.estimateLabel).toContain('indisponível');
    expect(preview.totalLabel).toContain('Indisponível');
    expect(preview.totalLabel).not.toMatch(/\$\d/);
  });

  it('distinguishes catalog loading from a confirmed missing price', () => {
    const preview = buildRosterCostPreview({
      roster,
      adapters,
      metadataByKey: {},
    });

    expect(preview.complete).toBe(false);
    expect(preview.lines[0]?.rateLabel).toContain('Consultando');
    expect(preview.totalLabel).toContain('Consultando');
    expect(preview.totalLabel).toContain('time');
    expect(preview.totalLabel).not.toContain('Indisponível');
  });

  it('forecasts human-readable waves without claiming they are the sealed plan', () => {
    const waves = forecastMissionWaves({
      lane: 'standard',
      maxWorkers: 3,
    });
    expect(waves).toHaveLength(4);
    expect(waves[0]?.title).toBe('Entender e planejar');
    expect(waves[1]?.detail).toMatch(/até 3 especialistas/i);
    expect(waves.at(-1)?.title).toBe('Validar e integrar');
  });

  it('uses singular and zero-worker language without promising parallelism', () => {
    expect(
      forecastMissionWaves({ lane: 'standard', maxWorkers: 1 })[1]?.detail,
    ).toBe('1 especialista pode executar a tarefa sem paralelismo.');
    expect(
      forecastMissionWaves({ lane: 'ops', maxWorkers: 0 })[1]?.detail,
    ).toContain('Nenhum especialista adicional');
  });

  it('does not call a roster promise of automatic P0–P3 review', () => {
    const squad: Squad = {
      id: 'outcome-bug-fix',
      name: 'Bug Fix',
      createdAt: '1',
      builtin: true,
      orchestratorInstructions: 'Review final.',
      agents: roster,
    };
    const status = missionReviewP0P3Status(squad);
    expect(status.kind).toBe('not-controlled');
    expect(status.label).toContain('Ainda não confirmado');
    expect(`${status.label} ${status.detail}`).toContain('revisores');
    expect(`${status.label} ${status.detail}`).not.toContain('motor');
  });

  it('identifies the dedicated Review P0–P3 mission without promising an extra phase', () => {
    const squad: Squad = {
      id: 'review-p0p3',
      name: 'Review P0–P3',
      createdAt: '1',
      builtin: true,
      orchestratorInstructions: 'Review.',
      agents: roster,
    };
    const status = missionReviewP0P3Status(squad);
    expect(status.kind).toBe('dedicated');
    expect(status.label).toContain('resultado principal');
    expect(status.detail).not.toContain('automática no final');
  });
});
