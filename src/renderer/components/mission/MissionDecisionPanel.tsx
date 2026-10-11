import { useCallback, useEffect, useRef, useState } from 'react';
import type { DecisionMissionPanel } from '../../../shared/decision-engine-ui';
import type {
  MissionCompletionHint, MissionDecisionHintReceipt, MissionKickoffHint, MissionRecoveryHint, MissionReviewTriageHint,
} from '../../../shared/orch-types';
import { formatDecisionPercent, formatDecisionTime, formatDecisionUsd } from '../../lib/decision-format';

/** Refresh leve: mudança da missão puxa de novo, no máximo a cada 15 s. */
export const MISSION_DECISION_REFRESH_MS = 15_000;

const PROVIDER_LABELS: Readonly<Record<string, string>> = { jev: 'Jev', clef: 'Clef', luna: 'Luna' };
const MODE_LABELS: Readonly<Record<DecisionMissionPanel['mode'], string>> = {
  auto: 'Automático', jev: 'Somente Jev', clef: 'Somente Clef', luna: 'Somente Luna', together: 'Juntos',
};
const COMPLEXITY_LABELS: Readonly<Record<MissionKickoffHint['complexityLevel'], string>> = {
  trivial: 'trivial', small: 'pequena', medium: 'média', large: 'grande',
};
const LANE_LABELS: Readonly<Record<MissionKickoffHint['lane'], string>> = {
  standard: 'padrão', consult: 'consulta', plan: 'plano', ops: 'operação',
};
const ADVICE_LABELS: Readonly<Record<MissionRecoveryHint['advice'], string>> = {
  'retry-same-cli': 'repetir a mesma CLI', 'switch-cli': 'trocar de CLI', 'escalate-orchestrator': 'devolver ao orquestrador',
};
const TRIGGER_LABELS: Readonly<Record<MissionRecoveryHint['triggerClass'], string>> = {
  'rate-limit': 'limite de taxa', quota: 'cota', auth: 'autenticação', transient: 'falha passageira',
  'model-rejected': 'modelo recusado', unknown: 'causa desconhecida',
};

type Tone = 'ok' | 'attention' | 'alert';

function budgetTone(ratio: number): Tone {
  return ratio >= 1 ? 'alert' : ratio >= 0.8 ? 'attention' : 'ok';
}

/**
 * O orçamento só RECUSA no Automático, nas consultas que ele escolhe. Checagens
 * fixas no Jev e modos com modelo fixo continuam e só entram na conta.
 */
function budgetNote(mode: DecisionMissionPanel['mode'], tone: Tone): string | null {
  if (mode !== 'auto') return tone === 'ok' ? null : 'Modelo fixo: o orçamento só contabiliza, não bloqueia.';
  if (tone === 'attention') return 'No Automático, só o modelo mais barato responde.';
  if (tone === 'alert') return 'Orçamento esgotado: o Automático parou de consultar nesta missão; as checagens fixas no Jev continuam e só entram na conta.';
  return null;
}

function routeLabel(hint: MissionDecisionHintReceipt): string {
  if (!hint.route) return hint.model;
  const provider = PROVIDER_LABELS[hint.route.provider] ?? hint.route.provider;
  return hint.route.model && hint.route.model !== hint.route.provider ? `${provider} · ${hint.route.model}` : provider;
}

interface HintRow { key: string; title: string; text: string; tone?: Tone; hint: MissionDecisionHintReceipt; extra?: string }

function kickoffRow(hint: MissionKickoffHint): HintRow {
  const workers = hint.workers === 1 ? '1 worker' : `${hint.workers} workers`;
  return { key: 'kickoff', title: 'Início', hint,
    text: `Complexidade ${COMPLEXITY_LABELS[hint.complexityLevel]} · ${workers} · trilha ${LANE_LABELS[hint.lane]}` };
}

function triageRow(hint: MissionReviewTriageHint): HintRow {
  const risk = formatDecisionPercent(hint.regressionRisk);
  return { key: `triage-${hint.handoffId}`, title: 'Triagem de risco', hint, tone: hint.recommendIndependentReview ? 'attention' : undefined,
    text: hint.recommendIndependentReview ? `Risco de regressão ${risk}: revisão independente sugerida` : `Risco de regressão ${risk}`,
    extra: `entrega ${hint.handoffId.slice(0, 12)}` };
}

function recoveryRow(hint: MissionRecoveryHint, index: number): HintRow {
  return { key: `recovery-${hint.at}-${index}`, title: 'Recuperação', hint,
    text: `Queda por ${TRIGGER_LABELS[hint.triggerClass]}: ${ADVICE_LABELS[hint.advice]}` };
}

function completionRow(hint: MissionCompletionHint): HintRow {
  const percent = formatDecisionPercent(hint.coverage);
  const audit = hint.finalAudit
    ? `auditoria final às ${formatDecisionTime(hint.finalAudit.at)}${hint.finalAudit.reused ? ' (sem nova consulta)' : ''}` : undefined;
  return { key: 'completion', title: 'Cobertura do objetivo', hint, tone: hint.warning ? 'attention' : 'ok', extra: audit,
    text: hint.warning
      ? `${percent}: ${hint.missing ? `parece faltar: ${hint.missing}` : 'algo do objetivo parece não ter sido entregue'}`
      : `${percent}: as entregas parecem cobrir o objetivo` };
}

function hintRows(panel: DecisionMissionPanel): HintRow[] {
  const hints = panel.hints;
  if (!hints) return [];
  return [
    ...(hints.kickoff ? [kickoffRow(hints.kickoff)] : []),
    ...(hints.reviewTriage ?? []).map(triageRow),
    ...(hints.recovery ?? []).map(recoveryRow),
    ...(hints.completion ? [completionRow(hints.completion)] : []),
  ];
}

type State = { kind: 'loading' } | { kind: 'error' } | { kind: 'ready'; panel: DecisionMissionPanel };

/**
 * F-1167: seção "Motor de decisão" da missão — gasto, orçamento e as dicas
 * consultivas com rota e horário. Só leitura; pull ao abrir e refresh leve
 * quando a missão muda (sem polling).
 */
export function MissionDecisionPanel({ missionId, version }: { missionId: string; version?: number }) {
  const [state, setState] = useState<State>({ kind: 'loading' });
  const lastFetch = useRef(0);
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null);
  const seenVersion = useRef(version);
  const supported = typeof window.nexus?.decisionModels?.missionPanel === 'function';

  const load = useCallback(async (signal: { active: boolean }) => {
    lastFetch.current = Date.now();
    try {
      const result = await window.nexus.decisionModels.missionPanel(missionId);
      if (!signal.active) return;
      setState(result.ok ? { kind: 'ready', panel: result } : { kind: 'error' });
    } catch {
      if (signal.active) setState({ kind: 'error' });
    }
  }, [missionId]);

  useEffect(() => {
    if (!supported) return undefined;
    const signal = { active: true };
    setState({ kind: 'loading' });
    void load(signal);
    return () => { signal.active = false; };
  }, [load, supported]);

  useEffect(() => {
    if (!supported || version === undefined || version === seenVersion.current) return undefined;
    seenVersion.current = version;
    const signal = { active: true };
    const wait = Math.max(0, lastFetch.current + MISSION_DECISION_REFRESH_MS - Date.now());
    if (pending.current) clearTimeout(pending.current);
    pending.current = setTimeout(() => { pending.current = null; void load(signal); }, wait);
    return () => {
      signal.active = false;
      if (pending.current) { clearTimeout(pending.current); pending.current = null; }
    };
  }, [version, load, supported]);

  if (!supported) return null;
  return <section className="mission-decision" aria-label="Motor de decisão" aria-busy={state.kind === 'loading'}>
    <h2>Motor de decisão</h2>
    {state.kind === 'loading' && <p className="mission-inspector__empty-value" role="status">Carregando…</p>}
    {state.kind === 'error' && <div className="mission-decision__error">
      <p role="status">Não consegui ler o motor de decisão desta missão.</p>
      <button type="button" className="mission-decision__retry" onClick={() => { setState({ kind: 'loading' }); void load({ active: true }); }}>
        Tentar de novo
      </button>
    </div>}
    {state.kind === 'ready' && <MissionDecisionBody panel={state.panel} />}
  </section>;
}

function MissionDecisionBody({ panel }: { panel: DecisionMissionPanel }) {
  const tone = budgetTone(panel.ratio);
  const providers = Object.entries(panel.byProvider).filter(([, row]) => row.calls + row.noAnswer > 0);
  const rows = hintRows(panel);
  return <>
    <dl className="mission-inspector__details">
      <div className="mission-inspector__field">
        <dt>Gasto de decisão</dt>
        <dd>
          {formatDecisionUsd(panel.chargedUsd)} de {formatDecisionUsd(panel.budgetUsd)}{' '}
          <span className={`mission-decision__budget mission-decision__budget--${tone}`}>({formatDecisionPercent(panel.ratio)})</span>
          {panel.reservedUsd > 0 && <span className="mission-decision__budget-note"> + {formatDecisionUsd(panel.reservedUsd)} em consultas em andamento.</span>}
          {budgetNote(panel.mode, tone) && <span className="mission-decision__budget-note"> {budgetNote(panel.mode, tone)}</span>}
        </dd>
      </div>
      <div className="mission-inspector__field">
        <dt>Chamadas</dt>
        <dd>{panel.calls} respondidas · {panel.noAnswer} sem resposta
          {panel.budgetRefusals > 0 ? ` · ${panel.budgetRefusals} recusadas pelo orçamento` : ''}</dd>
      </div>
      <div className="mission-inspector__field">
        <dt>Por provedor</dt>
        <dd>{providers.length === 0 ? <span className="mission-inspector__empty-value">Nenhuma chamada ainda.</span>
          : <ul className="mission-inspector__value-list">{providers.map(([provider, row]) => <li key={provider}>
            {PROVIDER_LABELS[provider] ?? provider}: {row.calls} {row.calls === 1 ? 'chamada' : 'chamadas'} · {formatDecisionUsd(row.usd)}
          </li>)}</ul>}</dd>
      </div>
      <div className="mission-inspector__field">
        <dt>Escolha do modelo</dt>
        <dd>{MODE_LABELS[panel.mode]}{panel.mode === 'auto' ? ': custo × qualidade' : ': modelo fixo, o motor só contabiliza'}</dd>
      </div>
    </dl>
    {rows.length === 0
      ? <p className="mission-inspector__empty-value">Nenhuma dica ainda. O motor sugere no início, nas entregas de código, em quedas e antes de concluir.</p>
      : <ul className="mission-decision__hints" aria-label="Dicas do motor de decisão">
        {rows.map(row => <li key={row.key} className={`mission-decision__hint${row.tone ? ` mission-decision__hint--${row.tone}` : ''}`}>
          <span className="mission-decision__hint-title">{row.title}</span>
          <span className="mission-decision__hint-text">{row.text}</span>
          <span className="mission-decision__hint-meta" title={row.hint.route?.reason}>
            {routeLabel(row.hint)} · {formatDecisionTime(row.hint.at)}{row.extra ? ` · ${row.extra}` : ''}
          </span>
        </li>)}
      </ul>}
  </>;
}
