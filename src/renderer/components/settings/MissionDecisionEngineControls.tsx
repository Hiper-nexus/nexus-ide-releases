import { useEffect, useId, useState } from 'react';
import {
  DEFAULT_MISSION_DECISION_BUDGET_USD, MAX_MISSION_DECISION_BUDGET_USD, missionDecisionBudgetUsd, type DecisionSettings,
} from '../../../shared/decision-models';
import type { OrchSettings } from '../../../shared/settings-types';
import { formatDecisionUsd, parseMissionBudgetInput } from '../../lib/decision-format';
import { CalibrateDecisionModels } from './CalibrateDecisionModels';

/** As quatro surfaces consultivas da missão (F-1166) que a chave liga e desliga juntas. */
export const MISSION_DECISION_SURFACES = ['missionKickoff', 'reviewTriage', 'recoveryAdvice', 'completionCheck'] as const;
/** Avisa a lista de superfícies (Padrões de execução) que o conjunto mudou fora dela. */
export const JEV_SURFACES_CHANGED_EVENT = 'nexus:jev-surfaces-changed';

type JevSurfaces = NonNullable<OrchSettings['jevSurfaces']>;

function budgetText(settings: DecisionSettings): string {
  return missionDecisionBudgetUsd(settings).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 4 });
}

export function MissionDecisionEngineControls({ settings, busy, onChange }: {
  settings: DecisionSettings; busy: boolean; onChange: (patch: Partial<DecisionSettings>) => void;
}) {
  const budgetId = useId();
  const [surfaces, setSurfaces] = useState<JevSurfaces | null>(null);
  const [autopilot, setAutopilot] = useState(true);
  const [saving, setSaving] = useState(false);
  const [toggleError, setToggleError] = useState<string | null>(null);
  const [readFailed, setReadFailed] = useState(false);
  const [draft, setDraft] = useState(() => budgetText(settings));
  const [budgetError, setBudgetError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    // Promise.resolve: ponte ausente ou que lança vira erro tratado, nunca quebra a tela.
    void Promise.resolve().then(() => window.nexus.settings.orchGet()).then(value => {
      if (!active) return;
      setSurfaces(value.jevSurfaces ?? null);
      setAutopilot(value.jevAutopilot !== false);
    }).catch(() => { if (active) setReadFailed(true); });
    return () => { active = false; };
  }, []);
  useEffect(() => { setDraft(budgetText(settings)); setBudgetError(null); }, [settings.missionBudgetUsd]);

  const enabledCount = surfaces ? MISSION_DECISION_SURFACES.filter(key => surfaces[key] !== false).length : 0;
  const enabled = surfaces !== null && enabledCount === MISSION_DECISION_SURFACES.length;
  const partial = surfaces !== null && enabledCount > 0 && !enabled;

  async function toggle(next: boolean): Promise<void> {
    if (saving) return;
    setSaving(true); setToggleError(null);
    try {
      // Patch PARCIAL: o Main mescla em `jevSurfaces` (F-1167), então nada que a lista ao lado gravou se perde.
      const patch = Object.fromEntries(MISSION_DECISION_SURFACES.map(key => [key, next])) as Partial<JevSurfaces>;
      const saved = await window.nexus.settings.orchSet({ jevSurfaces: patch });
      const applied = (saved?.jevSurfaces ?? { ...(surfaces ?? {}), ...patch }) as JevSurfaces;
      setSurfaces(applied);
      window.dispatchEvent(new CustomEvent(JEV_SURFACES_CHANGED_EVENT, { detail: applied }));
    } catch {
      setToggleError('Não consegui salvar. Tente de novo.');
    } finally { setSaving(false); }
  }

  function commitBudget(): void {
    const value = parseMissionBudgetInput(draft, MAX_MISSION_DECISION_BUDGET_USD);
    if (value === null) {
      setBudgetError(`Use um valor de US$ 0 a US$ ${MAX_MISSION_DECISION_BUDGET_USD}.`);
      return;
    }
    setBudgetError(null);
    if (value === (settings.missionBudgetUsd ?? 0) || (value === 0 && settings.missionBudgetUsd === undefined)) {
      setDraft(budgetText(settings));
      return;
    }
    onChange({ missionBudgetUsd: value });
  }

  return <div className="decision-engine" role="group" aria-label="Motor de decisão em toda missão">
    <label className="settings-toggle-row">
      <span className="settings-toggle-row__copy"><strong>Motor de decisão em toda missão</strong>
        <span>Dicas no início, na triagem de cada entrega de código, na queda de um worker e antes de concluir. Nunca bloqueia.</span></span>
      <input type="checkbox" aria-label="Motor de decisão em toda missão" checked={enabled}
        disabled={busy || saving || surfaces === null} onChange={event => void toggle(event.target.checked)} />
      <span className="settings-toggle-row__control" aria-hidden="true" />
    </label>
    {partial && <p className="settings-field__note">Ligado só em parte: {enabledCount} de 4 fases. Ligar aqui liga as quatro.</p>}
    {!autopilot && <p className="settings-field__note decision-engine__attention">O piloto automático está desligado: o motor não consulta nenhuma fase.</p>}
    {readFailed && <p className="settings-field__note">Não consegui ler as fases do motor. Reabra as configurações.</p>}
    {toggleError && <p className="settings-error" role="alert">{toggleError}</p>}
    <div className="settings-form-grid">
      <label className="settings-field" htmlFor={budgetId}>Orçamento por missão (US$)
        <input id={budgetId} className="settings-input" inputMode="decimal" aria-label="Orçamento por missão (US$)"
          aria-invalid={budgetError ? true : undefined} aria-describedby={budgetError ? `${budgetId}-error` : `${budgetId}-hint`}
          value={draft} disabled={busy} onChange={event => { setDraft(event.target.value); setBudgetError(null); }}
          onBlur={commitBudget} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); commitBudget(); } }} />
      </label>
    </div>
    {budgetError
      ? <p id={`${budgetId}-error`} className="settings-error" role="alert">{budgetError}</p>
      : <p id={`${budgetId}-hint`} className="settings-field__note">De 0 a {MAX_MISSION_DECISION_BUDGET_USD}. Zero usa o padrão de {formatDecisionUsd(DEFAULT_MISSION_DECISION_BUDGET_USD)}.
        {' '}No Automático, acima de 80% só o modelo mais barato responde e, em 100%, param as consultas que o Automático escolhe.
        {' '}As checagens fixas no Jev continuam e só entram na conta.</p>}
    <p className="settings-field__note">No Automático, o motor escolhe o modelo por custo e qualidade. Jev, Clef, Luna ou Juntos fixam o modelo: o motor só contabiliza o gasto.
      {' '}No Automático, as checagens de segurança ficam no Jev.</p>
    <CalibrateDecisionModels mode={settings.mode} />
  </div>;
}
