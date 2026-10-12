import { useRef, useState } from 'react';
import type { DecisionMode } from '../../../shared/decision-models';
import {
  DECISION_MEASUREMENT_STALE_MS, type DecisionCalibrationModel, type DecisionCalibrationModelResult, type DecisionCalibrationPlan,
} from '../../../shared/decision-engine-ui';
import { formatDecisionUsd } from '../../lib/decision-format';

const MODEL_LABELS: Readonly<Record<DecisionCalibrationModel, string>> = {
  jev: 'Jev', clef: 'Clef', 'clef-flash': 'Clef Flash', 'clef-omni': 'Clef-omni', luna: 'Luna (beta)',
};

type Phase =
  | { kind: 'idle' }
  | { kind: 'planning' }
  | { kind: 'confirm'; plan: DecisionCalibrationPlan }
  | { kind: 'running'; plan: DecisionCalibrationPlan }
  | { kind: 'done'; models: readonly DecisionCalibrationModelResult[]; written: boolean };

function isStale(measuredAt: number | null, now: number): boolean {
  return measuredAt !== null && now - measuredAt > DECISION_MEASUREMENT_STALE_MS;
}

function measuredText(measuredAt: number | null, now: number): string {
  if (measuredAt === null) return 'Sem medição';
  const date = new Date(measuredAt).toLocaleDateString('pt-BR');
  return isStale(measuredAt, now) ? `${date} (antiga)` : date;
}

/** Motivo mais comum das falhas, em linguagem do operador. A chave inválida ou sem acesso aparece como recusa da API. */
const FAILURE_TEXT: Readonly<Record<string, string>> = {
  'client-error': 'a API recusou a chave ou o acesso',
  'rate-limited': 'limite de uso do provedor',
  'server-error': 'erro no servidor do provedor',
  timeout: 'o provedor demorou demais',
  network: 'sem conexão com o provedor',
  malformed: 'resposta fora do formato',
  refusal: 'o provedor recusou a pergunta',
  'internal-error': 'falha interna do Nexus',
};

function accuracyText(row: DecisionCalibrationModelResult): string {
  if (row.skipped) return 'Pulado: sem credencial';
  if (row.accuracy === null) return row.failureReason ? `Sem resposta: ${FAILURE_TEXT[row.failureReason] ?? 'falha do provedor'}` : 'Sem resposta';
  return `${Math.round(row.accuracy * 100)}%`;
}

/**
 * F-1167: "Calibrar modelos" mede Jev, Clef e Luna num conjunto rotulado
 * embutido e grava a tabela de qualidade do roteador. Só roda com clique e
 * depois de mostrar o custo estimado. Falha vira mensagem; a tela segue.
 */
export function CalibrateDecisionModels({ mode }: { mode: DecisionMode }) {
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const lock = useRef(false);
  const supported = typeof window.nexus?.decisionModels?.calibrate === 'function';
  if (!supported) return null;
  const auto = mode === 'auto';

  async function plan(): Promise<void> {
    if (lock.current) return;
    lock.current = true; setError(null); setNotice(null); setPhase({ kind: 'planning' });
    try {
      const value = await window.nexus.decisionModels.calibrationPlan();
      if (!value.ok) throw new Error('plan');
      if (!value.runnable) {
        setError(value.reason === 'mode' ? 'A calibração só roda no modo Automático.' : 'Nenhum modelo com credencial para calibrar.');
        setPhase({ kind: 'idle' });
      } else setPhase({ kind: 'confirm', plan: value });
    } catch {
      setError('Não consegui estimar o custo da calibração.');
      setPhase({ kind: 'idle' });
    } finally { lock.current = false; }
  }

  async function run(current: DecisionCalibrationPlan): Promise<void> {
    if (!auto || lock.current) return;
    lock.current = true; setError(null); setNotice(null); setCancelling(false); setPhase({ kind: 'running', plan: current });
    try {
      const result = await window.nexus.decisionModels.calibrate();
      if (!result.ok) {
        // Cancelar não é erro: a tabela anterior continua valendo.
        if (result.cancelling) setNotice('Cancelando…');
        else if (result.cancelled) setNotice(result.error); else setError(result.error);
        setPhase({ kind: 'idle' }); return;
      }
      setPhase({ kind: 'done', models: result.models, written: result.written });
    } catch {
      setError('A calibração falhou. Nada foi alterado.');
      setPhase({ kind: 'idle' });
    } finally { lock.current = false; }
  }

  async function cancel(): Promise<void> {
    if (cancelling) return;
    setCancelling(true);
    try { await window.nexus.decisionModels.cancelCalibration(); } catch { setCancelling(false); }
  }

  const running = phase.kind === 'running';
  const now = Date.now();
  return <div className="decision-calibration" aria-busy={running || phase.kind === 'planning'}>
    <div className="settings-row decision-models__actions">
      <button className="settings-btn settings-btn--sm" type="button" disabled={!auto || running || phase.kind === 'planning'}
        onClick={() => void plan()}>{running ? 'Calibrando…' : 'Calibrar modelos'}</button>
    </div>
    <p className="settings-field__note">{auto
      ? 'Mede cada modelo com credencial em casos de teste prontos e ajusta a escolha do Automático. Só roda quando você clica.'
      : 'A calibração roda no modo Automático.'}</p>
    {phase.kind === 'planning' && <p className="settings-field__note" role="status">Estimando o custo…</p>}
    {(phase.kind === 'confirm' || phase.kind === 'running') && <div className="decision-models__confirm" role="group" aria-label="Confirmar calibração">
      <p className="settings-field__note">
        {phase.plan.cases} casos em {phase.plan.models.filter(row => row.available).length} modelos.
        {' '}Custo estimado: <strong>{formatDecisionUsd(phase.plan.estimatedUsd)}</strong>.
      </p>
      {phase.plan.models.some(row => !row.available) && <p className="settings-field__note">
        Sem credencial, pulados: {phase.plan.models.filter(row => !row.available).map(row => MODEL_LABELS[row.model]).join(', ')}.
        {' '}A medição anterior deles continua valendo.
      </p>}
      {phase.plan.models.some(row => isStale(row.measuredAt, now)) && <p className="settings-field__note decision-calibration__stale">
        Medição antiga (mais de 30 dias): {phase.plan.models.filter(row => isStale(row.measuredAt, now)).map(row => MODEL_LABELS[row.model]).join(', ')}.
      </p>}
      {running
        ? <div className="settings-row decision-models__actions">
          <p className="settings-field__note" role="status">{cancelling ? 'Cancelando…' : 'Calibrando. Pode levar alguns minutos.'}</p>
          <button className="settings-btn settings-btn--sm" type="button" disabled={cancelling} onClick={() => void cancel()}>Cancelar calibração</button>
        </div>
        : <div className="settings-row decision-models__actions">
          <button className="settings-btn" type="button" disabled={!auto} onClick={() => void run(phase.plan)}>Calibrar agora</button>
          <button className="settings-btn settings-btn--sm" type="button" onClick={() => setPhase({ kind: 'idle' })}>Cancelar</button>
        </div>}
    </div>}
    {phase.kind === 'done' && <div className="decision-models__table">
      <p className="settings-field__note" role="status">{phase.written
        ? 'Calibração concluída. O Automático já usa estas medições; as dos modelos pulados ficaram como estavam.'
        : 'Calibração concluída, mas não consegui gravar a tabela. O Automático segue com as estimativas padrão.'}</p>
      <table aria-label="Resultado da calibração">
        <thead><tr><th scope="col">Modelo</th><th scope="col">Acerto</th><th scope="col">p95</th><th scope="col">Custo</th><th scope="col">Medição</th></tr></thead>
        <tbody>{phase.models.map(row => <tr key={row.model} className={row.skipped ? 'decision-calibration__skipped' : undefined}>
          <th scope="row">{MODEL_LABELS[row.model]}</th>
          <td>{accuracyText(row)}</td>
          <td>{row.skipped || row.p95Ms === null ? '—' : `${(row.p95Ms / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} s`}</td>
          <td>{row.skipped ? '—' : row.usd === null ? 'Sem medição' : formatDecisionUsd(row.usd)}</td>
          <td className={isStale(row.measuredAt, now) ? 'decision-calibration__stale' : undefined}>{measuredText(row.measuredAt, now)}</td>
        </tr>)}</tbody>
      </table>
    </div>}
    {notice && <p className="settings-field__note" role="status">{notice}</p>}
    {error && <p className="settings-error" role="alert">{error}</p>}
  </div>;
}
