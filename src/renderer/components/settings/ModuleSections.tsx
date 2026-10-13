import { useEffect, useState } from 'react';
import { useSettingsStore } from '../../state/settings-store';
import { askConfirm } from '../../state/confirm-store';
import { useOrchStore } from '../../state/orch-store';
import {
  MISSION_SETUP_MAX_ROSTER,
  useMissionSetupStore,
} from '../../state/mission-setup-store';
import { useProductNavigationStore } from '../../state/product-navigation-store';
import { useWorkspaceStore } from '../../state/workspace-store';
import { useToastStore } from '../../state/toast-store';
import { PET_STUDIO_SQUAD_ID } from '../../../shared/pet-studio';
import { missionDeliveryRosterIssue } from '../../../shared/mission-engine-contract';
import { useVoiceStore } from '../../voice/voice-store';
import { CURRENT_RELEASE } from '../../../shared/release-notes';
import type {
  DesignDirection,
  OrchSettings,
} from '../../../shared/settings-types';
import {
  isMissionRuntimeSquadId,
  type Squad,
} from '../../../shared/orch-types';
import { UpdateReadinessPanel } from './ObservabilitySections';
import { AudioDeviceControls } from './AudioDeviceControls';
import { OrchestratorDefaults } from './OrchestratorDefaults';
import { AgentSessionSettings } from './AgentSessionSettings';
import { TerminalPerformanceStatus } from './TerminalPerformanceStatus';
import { SettingsSectionTitle } from './SettingsSectionTitle';
import { EmptyState } from '../ActionCard';
import { SquadEditor } from '../SquadEditor';
import { VoiceSettings } from '../VoiceSettings';
import { DecisionModelsSection } from './DecisionModelsSection';
import { JEV_SURFACES_CHANGED_EVENT } from './MissionDecisionEngineControls';

/** MÓDULOS sections: Terminal, Voice, Providers, Squads, Marketplace. */

function OrchestrationToggle({
  checked,
  title,
  detail,
  disabled,
  onChange,
}: {
  checked: boolean;
  title: string;
  detail: string;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="settings-toggle-row">
      <span className="settings-toggle-row__copy">
        <strong>{title}</strong>
        <span>{detail}</span>
      </span>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className="settings-toggle-row__control" aria-hidden="true" />
    </label>
  );
}

export function TerminalSection() {
  const terminal = useSettingsStore((s) => s.terminal);
  const update = useSettingsStore((s) => s.update);
  const [shells, setShells] = useState<string[]>([]);

  useEffect(() => {
    let cancelled = false;
    void window.nexus.settings.listShells().then((detected) => {
      if (!cancelled) setShells(detected);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <section className="sys-section">
      <SettingsSectionTitle>Terminal</SettingsSectionTitle>
      <p className="settings-detail__hint">
        Ajuste o funcionamento dos terminais. Fontes e cores ficam em Aparência.
      </p>

      <div className="sys-group">
        <div className="sys-group__head">
          <div className="sys-group__titles">
            <h3 className="sys-group__title">Shell</h3>
            <p className="sys-group__hint">
              Shell padrão para novos terminais. Terminais abertos não mudam.
            </p>
          </div>
        </div>
        <div className="sys-group__body">
          <label className="settings-field">
            Shell padrão
            <select
              className="settings-input"
              value={terminal.shell}
              onChange={(e) => void update({ shell: e.target.value })}
            >
              <option value="">
                Padrão do sistema{shells[0] ? ` — ${shells[0].split('/').pop()}` : ''}
              </option>
              {terminal.shell && !shells.includes(terminal.shell) && (
                <option value={terminal.shell}>{terminal.shell} (não detectado)</option>
              )}
              {shells.map((shell) => (
                <option key={shell} value={shell}>
                  {shell}
                </option>
              ))}
            </select>
            <span className="settings-field__note">
              {shells.length} opções disponíveis. A mudança vale para novos terminais.
            </span>
          </label>

          <details className="settings-advanced-field">
            <summary>Usar outro caminho absoluto</summary>
            <input
              className="settings-input"
              value={terminal.shell}
              placeholder="/caminho/para/seu/shell"
              onChange={(e) => void update({ shell: e.target.value })}
            />
          </details>
        </div>
      </div>

      <div className="sys-group">
        <div className="sys-group__head">
          <div className="sys-group__titles">
            <h3 className="sys-group__title">Desempenho</h3>
            <p className="sys-group__hint">
              Como os terminais fora de vista consomem recursos.
            </p>
          </div>
        </div>
        <div className="sys-group__body">
          <label className="settings-field">
            Modo de desempenho
            <select
              className="settings-input"
              value={terminal.performanceMode}
              onChange={(event) =>
                void update({
                  performanceMode: event.target.value as
                    | 'adaptive'
                    | 'quality',
                })
              }
            >
              <option value="adaptive">Adaptativo — recomendado</option>
              <option value="quality">Qualidade — atualizar todos os terminais</option>
            </select>
            <span className="settings-field__note">
              Adaptativo reduz o consumo de recursos nos terminais fora de vista.
              Qualidade mantém todos os terminais atualizando.
            </span>
          </label>

          <details className="settings-advanced-field">
            <summary>Detalhes de desempenho</summary>
            <TerminalPerformanceStatus />
          </details>
        </div>
      </div>
    </section>
  );
}

export function VoiceSection() {
  const openVoice = useVoiceStore((s) => s.openSettings);
  return (
    <section className="sys-section">
      <div className="settings-detail__split-head">
        <div>
          <SettingsSectionTitle>Jarvis & Voz</SettingsSectionTitle>
          <p className="settings-detail__hint">
            Configure a assistente Jarvis, modo contínuo de conversa ao vivo em tempo real, respostas faladas e microfone.
          </p>
        </div>
        <button
          type="button"
          className="settings-btn"
          onClick={() => {
            openVoice();
          }}
        >
          Abrir em janela separada
        </button>
      </div>
      <VoiceSettings embedded />
      <AudioDeviceControls />
    </section>
  );
}

export function SystemSection() {
  const release = CURRENT_RELEASE;
  return (
    <section className="sys-section">
      <div className="release-head">
        <div>
          <SettingsSectionTitle>Sistema</SettingsSectionTitle>
          <p className="settings-detail__hint">
            Veja a versão do app, as novidades e as atualizações disponíveis.
          </p>
        </div>
        <span className="release-version">v{release.version}</span>
      </div>

      <div className="release-summary">
        <div>
          <span className="settings-chip settings-chip--ok">instalada</span>
          <span className="settings-chip">{release.date}</span>
          <span className="settings-chip">{release.codename}</span>
        </div>
        <p>{release.summary}</p>
      </div>

      <div className="sys-cols-2">
        <div>
          <div className="sys-subhead">
            <h3 className="sys-subhead__title">Melhorias desta versão</h3>
            <span className="sys-subhead__meta">{release.highlights.length}</span>
          </div>
          <ul className="settings-list">
            {release.highlights.map((item) => (
              <li key={item.title} className="settings-list__item release-note">
                <div className="settings-list__head">
                  <span className="settings-list__title">{item.title}</span>
                </div>
                <p className="settings-list__detail">{item.detail}</p>
              </li>
            ))}
          </ul>
        </div>
        <div>
          <div className="sys-subhead">
            <h3 className="sys-subhead__title">Correções desta versão</h3>
            <span className="sys-subhead__meta">{release.fixes.length}</span>
          </div>
          <ul className="settings-list">
            {release.fixes.map((item) => (
              <li key={item.title} className="settings-list__item release-note">
                <div className="settings-list__head">
                  <span className="settings-list__title">{item.title}</span>
                </div>
                <p className="settings-list__detail">{item.detail}</p>
              </li>
            ))}
          </ul>
        </div>
      </div>

      <UpdateReadinessPanel />
    </section>
  );
}

const DESIGN_DIRECTION_LABELS: Array<{
  value: DesignDirection;
  label: string;
}> = [
  { value: 'auto', label: 'Auto — segue o design system do projeto' },
  { value: 'minimalist', label: 'Minimalista — reduzir ao essencial' },
  { value: 'brutalist', label: 'Brutalista — cru, denso, sem arredondar' },
  { value: 'soft', label: 'Soft — acolhedor, cantos e sombras suaves' },
];

function DesignDial({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <label className="settings-field">
      {label}: {value}/10{value === 5 ? ' (neutro)' : ''}
      <input
        className="settings-range"
        type="range"
        min={1}
        max={10}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </label>
  );
}

type SquadOperation = 'import' | 'export' | `delete:${string}`;

type SquadFeedback = {
  tone: 'info' | 'success' | 'error';
  message: string;
};

function createSquadDraft(): Squad {
  const draftId = crypto.randomUUID();
  return {
    id: `squad-${draftId}`,
    name: '',
    createdAt: String(Date.now()),
    builtin: false,
    orchestratorInstructions: '',
    agents: [
      {
        id: `coordinator-${draftId}`,
        agentName: 'Coordenador',
        category: 'orchestrator',
        cli: 'codex',
        allowedSkills: [],
        allowedTools: null,
      },
      {
        id: `executor-${draftId}`,
        agentName: 'Executor',
        category: 'executor',
        cli: 'codex',
        allowedSkills: [],
        allowedTools: null,
      },
      {
        id: `reviewer-${draftId}`,
        agentName: 'Revisor',
        category: 'reviewer',
        cli: 'codex',
        allowedSkills: [],
        allowedTools: null,
      },
    ],
  };
}

function squadResultError(result: unknown): string | null {
  if (!result || typeof result !== 'object' || !('error' in result)) return null;
  const error = result.error;
  return typeof error === 'string' && error.trim() ? error : null;
}

function squadFailureMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message.trim()
    ? cause.message
    : fallback;
}

export type SquadNameGroup = { name: string; squads: Squad[] };

/**
 * Agrupa equipes salvas com o MESMO nome (após aparar espaços), na ordem da
 * primeira aparição. Cada grupo guarda as cópias na ordem original.
 */
export function groupSquadsByName(squads: readonly Squad[]): SquadNameGroup[] {
  const byName = new Map<string, Squad[]>();
  for (const squad of squads) {
    const key = squad.name.trim();
    byName.set(key, [...(byName.get(key) ?? []), squad]);
  }
  return [...byName.entries()].map(([name, grouped]) => ({ name, squads: grouped }));
}

/** Carimbos anteriores a 2000 não são datas de criação reais (fixtures, ids). */
const MIN_PLAUSIBLE_CREATED_AT_MS = 946_684_800_000;

function squadCopyLabel(squad: Squad, ordinal: number): string {
  const createdAt = Number(squad.createdAt);
  if (Number.isFinite(createdAt) && createdAt >= MIN_PLAUSIBLE_CREATED_AT_MS) {
    const date = new Date(createdAt);
    return `Cópia ${ordinal} · ${date.toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}`;
  }
  return `Cópia ${ordinal}`;
}

export function SquadsSection() {
  const squads = useOrchStore((s) => s.squads);
  const visibleSquads = squads
    .filter((squad) => !isMissionRuntimeSquadId(squad.id))
    .sort((a, b) => Number(a.builtin ?? false) - Number(b.builtin ?? false));
  const [editing, setEditing] = useState<Squad | null>(null);
  const [feedback, setFeedback] = useState<SquadFeedback | null>(null);
  const [operation, setOperation] = useState<SquadOperation | null>(null);
  const [leanCode, setLeanCode] = useState(true);
  const [seniorMode, setSeniorMode] = useState(true);
  const [jevAutopilot, setJevAutopilot] = useState(true);
  const [jevSurfaces, setJevSurfaces] = useState<
    NonNullable<OrchSettings['jevSurfaces']>
  >({
    handoffReview: true,
    intake: true,
    paneState: true,
    terminalTriage: true,
    rank: true,
    dispatchGuard: true,
    toolPick: true,
    taskRouting: true,
    browserTool: true,
    researchTriage: true,
    delegation: true,
    memoryDistill: true,
    helperReuse: true,
    businessModel: true,
    missionPick: true,
    catalogPick: true,
    missionMomentum: true,
    missionKickoff: true,
    reviewTriage: true,
    recoveryAdvice: true,
    completionCheck: true,
  });
  const [designPro, setDesignPro] = useState(true);
  const [memoryInjection, setMemoryInjection] = useState(true);
  const [memoryVaultExport, setMemoryVaultExport] = useState(false);
  const [designDirection, setDesignDirection] = useState<DesignDirection>('auto');
  const [designVariance, setDesignVariance] = useState(5);
  const [designMotion, setDesignMotion] = useState(5);
  const [designDensity, setDesignDensity] = useState(5);

  useEffect(() => {
    void window.nexus.settings.orchGet().then((o) => {
      setLeanCode(o.leanCode);
      setSeniorMode(o.seniorMode);
      setJevAutopilot(o.jevAutopilot !== false);
      setJevSurfaces({
        handoffReview: o.jevSurfaces?.handoffReview !== false,
        intake: o.jevSurfaces?.intake !== false,
        paneState: o.jevSurfaces?.paneState !== false,
        terminalTriage: o.jevSurfaces?.terminalTriage !== false,
        rank: o.jevSurfaces?.rank !== false,
        dispatchGuard: o.jevSurfaces?.dispatchGuard !== false,
        toolPick: o.jevSurfaces?.toolPick !== false,
        taskRouting: o.jevSurfaces?.taskRouting !== false,
        browserTool: o.jevSurfaces?.browserTool !== false,
        researchTriage: o.jevSurfaces?.researchTriage !== false,
        delegation: o.jevSurfaces?.delegation !== false,
        memoryDistill: o.jevSurfaces?.memoryDistill !== false,
        helperReuse: o.jevSurfaces?.helperReuse !== false,
        businessModel: o.jevSurfaces?.businessModel !== false,
        missionPick: o.jevSurfaces?.missionPick !== false,
        catalogPick: o.jevSurfaces?.catalogPick !== false,
        missionMomentum: o.jevSurfaces?.missionMomentum !== false,
        missionKickoff: o.jevSurfaces?.missionKickoff !== false,
        reviewTriage: o.jevSurfaces?.reviewTriage !== false,
        recoveryAdvice: o.jevSurfaces?.recoveryAdvice !== false,
        completionCheck: o.jevSurfaces?.completionCheck !== false,
      });
      setDesignPro(o.designPro);
      setMemoryInjection(o.workspaceMemoryInjection !== false);
      setMemoryVaultExport(o.workspaceMemoryVaultExport === true);
      setDesignDirection(o.designDirection ?? 'auto');
      setDesignVariance(o.designVariance ?? 5);
      setDesignMotion(o.designMotion ?? 5);
      setDesignDensity(o.designDensity ?? 5);
    });
  }, []);

  // F-1167: a chave "Motor de decisão em toda missão" grava as quatro fases de
  // uma vez; a lista abaixo acompanha para não regravar um valor velho.
  useEffect(() => {
    const onSurfaces = (event: Event) => {
      const detail = (event as CustomEvent<Partial<NonNullable<OrchSettings['jevSurfaces']>>>).detail;
      if (detail && typeof detail === 'object') setJevSurfaces((current) => ({ ...current, ...detail }));
    };
    window.addEventListener(JEV_SURFACES_CHANGED_EVENT, onSurfaces);
    return () => window.removeEventListener(JEV_SURFACES_CHANGED_EVENT, onSurfaces);
  }, []);

  function openCreateEditor() {
    setFeedback(null);
    setEditing(createSquadDraft());
  }

  function useMembers(squad: Squad): void {
    if (squad.id === PET_STUDIO_SQUAD_ID) {
      useProductNavigationStore.getState().openSettings('pets');
      return;
    }
    const workspacePath = useWorkspaceStore.getState().current?.path;
    if (!workspacePath) {
      setFeedback({ tone: 'error', message: 'Abra um projeto antes de usar estes integrantes.' });
      return;
    }
    const setup = useMissionSetupStore.getState();
    setup.clearEntryContext();
    setup.setWorkspace(workspacePath);
    if (!setup.setRoster(squad.agents)) {
      // F-1496: o tamanho é a única causa que o usuário consegue ver; a outra
      // é um integrante com dado que a missão não aceita.
      setFeedback({
        tone: 'error',
        message:
          squad.agents.length > MISSION_SETUP_MAX_ROSTER
            ? `Não foi possível aplicar os integrantes: esta equipe tem ${squad.agents.length} pessoas e a missão aceita até ${MISSION_SETUP_MAX_ROSTER}. Remova alguns no editor e tente de novo.`
            : 'Não foi possível aplicar os integrantes: um deles tem um dado que a missão não aceita. Abra a equipe no editor, salve de novo e tente outra vez.',
      });
      return;
    }
    const { draft } = useMissionSetupStore.getState();
    const issue = missionDeliveryRosterIssue(draft.roster, draft.advanced.lane);
    setup.setStep(issue ? 'team' : 'mission');
    useProductNavigationStore.getState().openMissionSetup();
    if (issue) {
      useToastStore.getState().push('warn', 'Complete a equipe',
        issue === 'reviewer-required'
          ? 'Adicione ao menos uma pessoa independente para verificar a entrega.'
          : 'Adicione ao menos uma pessoa responsável por implementar ou executar a entrega.',
      );
    }
  }

  async function importSquads() {
    if (operation) return;
    setOperation('import');
    setFeedback(null);
    try {
      const result = await window.nexus.orch.importSquads();
      const error = squadResultError(result);
      if (result.ok) {
        const count = result.count ?? 0;
        setFeedback({
          tone: 'success',
          message: `Importados ${count} ${count === 1 ? 'squad' : 'squads'}.`,
        });
      } else if (!error || error === 'user_denied') {
        setFeedback({ tone: 'info', message: 'Importação cancelada.' });
      } else {
        setFeedback({ tone: 'error', message: error });
      }
    } catch (cause) {
      setFeedback({
        tone: 'error',
        message: squadFailureMessage(
          cause,
          'Não foi possível importar os squads.',
        ),
      });
    } finally {
      setOperation(null);
    }
  }

  async function exportSquads() {
    if (operation || visibleSquads.length === 0) return;
    setOperation('export');
    setFeedback(null);
    try {
      const result = await window.nexus.orch.exportSquads();
      const error = squadResultError(result);
      if (result.ok && result.path) {
        setFeedback({
          tone: 'success',
          message: `Squads exportados para ${result.path}.`,
        });
      } else if (result.ok) {
        setFeedback({
          tone: 'error',
          message: 'A exportação terminou sem informar o arquivo salvo.',
        });
      } else if (!error || error === 'user_denied') {
        setFeedback({ tone: 'info', message: 'Exportação cancelada.' });
      } else {
        setFeedback({ tone: 'error', message: error });
      }
    } catch (cause) {
      setFeedback({
        tone: 'error',
        message: squadFailureMessage(
          cause,
          'Não foi possível exportar os squads.',
        ),
      });
    } finally {
      setOperation(null);
    }
  }

  async function deleteSavedSquad(squad: Squad) {
    if (operation) return;
    const operationId: SquadOperation = `delete:${squad.id}`;
    setOperation(operationId);
    setFeedback(null);
    try {
      const confirmed = await askConfirm({
        title: `Apagar o squad "${squad.name}"?`,
        body: 'O squad salvo será removido. Esta ação não pode ser desfeita.',
        confirmLabel: 'Apagar squad',
        cancelLabel: 'Manter squad',
        danger: true,
      });
      if (!confirmed) {
        setFeedback({ tone: 'info', message: 'Exclusão cancelada.' });
        return;
      }

      const result = await window.nexus.orch.deleteSquad(squad.id);
      const error = squadResultError(result);
      if (result.ok) {
        setFeedback({
          tone: 'success',
          message: `Squad "${squad.name}" apagado.`,
        });
      } else if (error === 'user_denied') {
        setFeedback({ tone: 'info', message: 'Exclusão cancelada.' });
      } else {
        setFeedback({
          tone: 'error',
          message: error ?? `Não foi possível apagar o squad "${squad.name}".`,
        });
      }
    } catch (cause) {
      setFeedback({
        tone: 'error',
        message: squadFailureMessage(
          cause,
          `Não foi possível apagar o squad "${squad.name}".`,
        ),
      });
    } finally {
      setOperation(null);
    }
  }

  const squadGroups = groupSquadsByName(visibleSquads);

  function renderSquadRow(squad: Squad, copyCount?: number, copyLabel?: string) {
    const deleting = operation === `delete:${squad.id}`;
    const members = squad.agents.map((agent) => agent.agentName).join(' · ');
    const target = copyLabel ? ` (${copyLabel})` : '';
    return (
      <>
        <div className="settings-list__head settings-squads__row">
          <span className="settings-list__title">{copyLabel ?? squad.name}</span>
          {copyCount ? (
            <span
              className="settings-chip settings-squads__count"
              title={`${copyCount} equipes salvas com este nome`}
            >
              {copyCount} cópias
            </span>
          ) : null}
          <span className="settings-chip">{squad.builtin ? 'original' : 'seu'}</span>
          <span className="settings-chip">
            {squad.agents.length} {squad.agents.length === 1 ? 'agente' : 'agentes'}
          </span>
          <div className="settings-squads__row-actions">
            <button
              type="button"
              className="settings-btn settings-btn--primary"
              disabled={operation !== null}
              aria-label={copyLabel ? `Usar integrantes${target}` : undefined}
              onClick={() => useMembers(squad)}
            >
              {squad.id === PET_STUDIO_SQUAD_ID ? 'Criar pet' : 'Usar integrantes'}
            </button>
            <button
              type="button"
              className="settings-btn"
              disabled={operation !== null}
              aria-label={copyLabel ? `${squad.builtin ? 'Personalizar' : 'Editar'}${target}` : undefined}
              title={
                squad.builtin
                  ? 'Criar uma cópia editável desta equipe'
                  : 'Editar nome, instruções e agentes'
              }
              onClick={() => {
                setFeedback(null);
                setEditing(squad);
              }}
            >
              {squad.builtin ? 'Personalizar' : 'Editar'}
            </button>
            {!squad.builtin ? (
              <>
                <span className="settings-squads__action-sep" aria-hidden="true" />
                <button
                  type="button"
                  className="settings-btn settings-squads__delete"
                  disabled={operation !== null}
                  aria-label={copyLabel ? `Apagar${target}` : undefined}
                  onClick={() => void deleteSavedSquad(squad)}
                >
                  {deleting ? 'Apagando…' : 'Apagar'}
                </button>
              </>
            ) : null}
          </div>
        </div>
        {members && (
          <p className="settings-list__detail settings-squads__members" title={members}>
            {members}
          </p>
        )}
      </>
    );
  }

  const managementActions = (
    <div className="settings-squads__actions">
      <button
        type="button"
        className="settings-btn settings-btn--primary"
        onClick={openCreateEditor}
        disabled={operation !== null}
      >
        Criar equipe
      </button>
      <button
        type="button"
        className="settings-btn"
        onClick={() => void importSquads()}
        disabled={operation !== null}
      >
        {operation === 'import' ? 'Importando…' : 'Importar'}
      </button>
      <button
        type="button"
        className="settings-btn"
        onClick={() => void exportSquads()}
        disabled={operation !== null || visibleSquads.length === 0}
      >
        {operation === 'export' ? 'Exportando…' : 'Exportar'}
      </button>
    </div>
  );

  return (
    <section className="sys-section">
      <SettingsSectionTitle>Equipes</SettingsSectionTitle>
      <p className="settings-detail__hint">
        Salve integrantes e suas configurações para montar novas equipes.
      </p>

      <section className="settings-squads__block settings-squads__block--autopilot" aria-label="Piloto automático">
        <OrchestratorDefaults />
      </section>

      <section className="settings-squads__block" aria-labelledby="settings-squads-saved-title">
      <div className="settings-section-heading settings-section-heading--with-count">
        <h3 id="settings-squads-saved-title">Equipes salvas</h3>
        <span className="settings-chip">{visibleSquads.length}</span>
      </div>
      {visibleSquads.length === 0 ? (
        <EmptyState
          className="settings-squads__empty"
          icon="users"
          title="Nenhuma equipe salva"
          body={
            <p>
              Crie uma equipe reutilizável ou importe suas equipes.
            </p>
          }
          action={managementActions}
        />
      ) : (
        <>
          {managementActions}
          <ul className="settings-list" aria-label="Equipes salvas">
            {squadGroups.map((group) => {
              const [lead, ...copies] = group.squads;
              if (copies.length === 0) {
                return (
                  <li key={lead.id} className="settings-list__item">
                    {renderSquadRow(lead)}
                  </li>
                );
              }
              return (
                <li
                  key={`group:${lead.id}`}
                  className="settings-list__item settings-squads__group"
                >
                  {renderSquadRow(lead, group.squads.length)}
                  <details className="settings-squads__copies">
                    <summary>
                      {copies.length === 1
                        ? 'Ver a outra cópia'
                        : `Ver as outras ${copies.length} cópias`}
                    </summary>
                    <ul
                      className="settings-list"
                      aria-label={`Cópias de ${group.name}`}
                    >
                      {copies.map((copy, index) => (
                        <li
                          key={copy.id}
                          className="settings-list__item settings-squads__copy"
                        >
                          {renderSquadRow(copy, undefined, squadCopyLabel(copy, index + 2))}
                        </li>
                      ))}
                    </ul>
                  </details>
                </li>
              );
            })}
          </ul>
        </>
      )}
      </section>
      {feedback ? (
        <p
          className={`settings-squads__feedback settings-squads__feedback--${feedback.tone}`}
          role={feedback.tone === 'error' ? 'alert' : 'status'}
          aria-atomic="true"
        >
          {feedback.message}
        </p>
      ) : null}
      <p className="settings-field__note">
        Usar integrantes copia papéis, ferramentas, modelos e instruções
        individuais para Nova missão. Permissões e skills seguem as regras de
        execução do Nexus. As instruções globais permanecem no catálogo acessado
        via MCP e não são aplicadas por essa ação.
      </p>

      <details className="settings-advanced-field">
        <summary>Comportamento dos agentes e estilo de trabalho</summary>
      <AgentSessionSettings />

      <h3 className="settings-section-heading">Padrões de execução</h3>
      <DecisionModelsSection showCredentials={false} />
      <div className="settings-toggle-list">
        <OrchestrationToggle
          checked={seniorMode}
          title="Disciplina sênior"
          detail="Orienta os agentes a validar a stack, executar testes e lint, revisar segurança e manter a documentação."
          onChange={(checked) => {
            setSeniorMode(checked);
            void window.nexus.settings.orchSet({ seniorMode: checked });
          }}
        />
        <OrchestrationToggle
          checked={jevAutopilot}
          title="Piloto automático"
          detail="Consulta o modelo de decisão configurado nas triagens e na revisão de evidência dos handoffs. Precisa de Jev ou Clef configurado em Chaves de API."
          onChange={(checked) => {
            setJevAutopilot(checked);
            void window.nexus.settings.orchSet({ jevAutopilot: checked });
          }}
        />
        <div className="sys-toggle-divider">
          Superfícies supervisionadas pelos modelos de decisão
        </div>
        {(
          [
              ['handoffReview', 'Revisão de evidência dos handoffs'],
              [
                'intake',
                'Triagem do pedido (complexidade, risco, ambiguidade, skills)',
              ],
              ['paneState', 'Estado dos panes'],
              ['terminalTriage', 'Triagem de falha de comandos'],
              ['rank', 'Ranking de entregas'],
              [
                'dispatchGuard',
                'Guarda de chamadas de ferramenta (coerência, injeção, efeito destrutivo)',
              ],
              ['toolPick', 'Recomendação de ferramenta (nexus_tool_pick)'],
              ['taskRouting', 'Roteamento de tarefas (nexus_route_task)'],
              ['browserTool', 'Navegador do agente (desempate, julgamento, extração)'],
              ['researchTriage', 'Pesquisa de dados (melhor resposta + falta pesquisar)'],
              ['delegation', 'Delegação automática (dividir pedidos em panes)'],
              [
                'memoryDistill',
                'Destilação de memória (handoff aceito, fim de sessão, preferência do operador)',
              ],
              [
                'helperReuse',
                'Reuso de helper ocioso (tarefa nova para pane parado com contexto)',
              ],
              [
                'businessModel',
                'Modelo de negócio por tarefa (fluxos, invariantes e hurdles relevantes)',
              ],
              [
                'missionPick',
                'Missão falada (desempate entre títulos parecidos, por voz)',
              ],
              [
                'catalogPick',
                'Marketplace (agentes e instruções recomendados para a stack do projeto)',
              ],
              [
                'missionMomentum',
                'Momentum da missão (preso vs gate longo — refina o nudge do supervisor)',
              ],
              ['missionKickoff', 'Início da missão (complexidade, workers e lane sugeridos)'],
              ['reviewTriage', 'Triagem de revisão (risco de regressão do handoff de código)'],
              ['recoveryAdvice', 'Recuperação de worker (repetir a CLI, trocar ou escalar)'],
              ['completionCheck', 'Conclusão (os handoffs cobrem o objetivo? só aviso)'],
            ] as const
          ).map(([surface, label]) => (
            <OrchestrationToggle
              key={surface}
              checked={jevSurfaces[surface] !== false}
              disabled={!jevAutopilot}
              title={label}
              detail=""
              onChange={(checked) => {
                const next = { ...jevSurfaces, [surface]: checked };
                setJevSurfaces(next);
                // F-1167: só a chave mudada; o Main mescla no objeto atual.
                void window.nexus.settings.orchSet({ jevSurfaces: { [surface]: checked } });
              }}
            />
          ))}
        <div className="sys-toggle-divider">
          Estilo de trabalho
        </div>
        <OrchestrationToggle
          checked={designPro}
          title="Design profissional"
          detail="Adiciona orientações de acabamento visual. Seguir o contrato de design do projeto é uma regra permanente do motor."
          onChange={(checked) => {
            setDesignPro(checked);
            void window.nexus.settings.orchSet({ designPro: checked });
          }}
        />
        <OrchestrationToggle
          checked={memoryInjection}
          title="Memória do projeto nos prompts"
          detail="Anexa as memórias confiáveis do projeto ao início de cada pane. Desligar não apaga nem deixa de gravar memórias."
          onChange={(checked) => {
            setMemoryInjection(checked);
            void window.nexus.settings.orchSet({ workspaceMemoryInjection: checked });
          }}
        />
        <OrchestrationToggle
          checked={memoryVaultExport}
          title="Memória visível no projeto (abre no Obsidian)"
          detail="Grava uma cópia legível da memória em .nexus-memory/ na pasta do projeto, fora do git. Desligado, a memória continua em userData; panes somente-leitura nunca escrevem na pasta."
          onChange={(checked) => {
            setMemoryVaultExport(checked);
            void window.nexus.settings.orchSet({ workspaceMemoryVaultExport: checked });
          }}
        />
        <OrchestrationToggle
          checked={leanCode}
          title="Código enxuto"
          detail="Prioriza reuso e a menor implementação segura, sem abstrações ou dependências desnecessárias."
          onChange={(checked) => {
            setLeanCode(checked);
            void window.nexus.settings.orchSet({ leanCode: checked });
          }}
        />
      </div>
      {designPro && (
        <>
          <h3 className="settings-section-heading">
            Perfil de design (tarefas de UI)
          </h3>
          <p className="settings-detail__hint">
            Ajuste o estilo sugerido aos agentes. A direção automática segue as referências do projeto.
          </p>
          <label className="settings-field">
            Direção estética
            <select
              className="settings-input"
              value={designDirection}
              onChange={(event) => {
                const value = event.target.value as DesignDirection;
                setDesignDirection(value);
                void window.nexus.settings.orchSet({ designDirection: value });
              }}
            >
              {DESIGN_DIRECTION_LABELS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <DesignDial
            label="Ousadia de layout"
            value={designVariance}
            onChange={(value) => {
              setDesignVariance(value);
              void window.nexus.settings.orchSet({ designVariance: value });
            }}
          />
          <DesignDial
            label="Intensidade das animações"
            value={designMotion}
            onChange={(value) => {
              setDesignMotion(value);
              void window.nexus.settings.orchSet({ designMotion: value });
            }}
          />
          <DesignDial
            label="Densidade visual"
            value={designDensity}
            onChange={(value) => {
              setDesignDensity(value);
              void window.nexus.settings.orchSet({ designDensity: value });
            }}
          />
        </>
      )}

      </details>

      {editing ? (
        <SquadEditor
          key={editing.id}
          squad={editing}
          mode={editing.name ? 'edit' : 'create'}
          onClose={() => setEditing(null)}
          onSaved={(message) =>
            setFeedback({ tone: 'success', message })
          }
        />
      ) : null}
    </section>
  );
}

export { MarketplaceSection } from './MarketplaceSection';
