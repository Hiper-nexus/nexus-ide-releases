import { useEffect, useState } from 'react';
import { useSettingsStore } from '../../state/settings-store';
import { askConfirm } from '../../state/confirm-store';
import { useOrchStore } from '../../state/orch-store';
import { useVoiceStore } from '../../voice/voice-store';
import { CURRENT_RELEASE } from '../../../shared/release-notes';
import type { DesignDirection } from '../../../shared/settings-types';
import {
  isMissionRuntimeSquadId,
  type Squad,
} from '../../../shared/orch-types';
import { UpdateReadinessPanel } from './ObservabilitySections';
import { AudioDeviceControls } from './AudioDeviceControls';
import { OrchestratorDefaults } from './OrchestratorDefaults';
import { MissionDriverSettings } from './MissionDriverSettings';
import { TerminalPerformanceStatus } from './TerminalPerformanceStatus';
import { SettingsSectionTitle } from './SettingsSectionTitle';
import { EmptyState } from '../ActionCard';
import { SquadEditor } from '../SquadEditor';

/** MÓDULOS sections: Terminal, Voice, Providers, Squads, Marketplace. */

function OrchestrationToggle({
  checked,
  title,
  detail,
  onChange,
}: {
  checked: boolean;
  title: string;
  detail: string;
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
    <section>
      <SettingsSectionTitle>Terminal</SettingsSectionTitle>
      <p className="settings-detail__hint">
        Fonte e shell dos panes xterm. Paleta e modo pixel ficam em Aparência.
      </p>

      <label className="settings-field">
        Desempenho dos panes
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
          <option value="quality">Qualidade — pintar todos os panes</option>
        </select>
        <span className="settings-field__note">
          Adaptativo agrupa frames de agentes, estaciona panes fora de vista e
          usa scrollback menor. Qualidade mantém todos os panes atualizando.
        </span>
      </label>

      <TerminalPerformanceStatus />

      <label className="settings-field">
        Fonte (vazio = padrão do sistema)
        <input
          className="settings-input"
          value={terminal.fontFamily}
          placeholder='ex.: "JetBrains Mono", monospace'
          onChange={(e) => void update({ fontFamily: e.target.value })}
        />
      </label>

      <label className="settings-field">
        Tamanho da fonte: {terminal.fontSize}px
        <input
          className="settings-range"
          type="range"
          min={9}
          max={24}
          value={terminal.fontSize}
          onChange={(e) => void update({ fontSize: Number(e.target.value) })}
        />
      </label>

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
          {shells.length} shell(s) detectado(s). Vale para novos panes; os já
          abertos continuam no shell atual.
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
    </section>
  );
}

export function VoiceSection({ onNavigate }: { onNavigate: () => void }) {
  const openVoice = useVoiceStore((s) => s.openSettings);
  return (
    <section>
      <SettingsSectionTitle>Voice</SettingsSectionTitle>
      <p className="settings-detail__hint">
        Voz e captura: push-to-talk, STT (Groq/whisper), tradução PT→EN e
        resposta falada (Jarvis). Config em ~/.nexus/plugins/voice.
      </p>
      <AudioDeviceControls />
      <button
        className="settings-btn settings-btn--primary"
        onClick={() => {
          onNavigate();
          openVoice();
        }}
      >
        Abrir configurações de voz
      </button>
    </section>
  );
}

export function SystemSection() {
  const release = CURRENT_RELEASE;
  return (
    <section>
      <div className="release-head">
        <div>
          <SettingsSectionTitle>Sistema</SettingsSectionTitle>
          <p className="settings-detail__hint">
            Versão atual, changelog e estado do pacote local instalado.
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

      <h4 className="release-section-title">Changelog · melhorias</h4>
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

      <h4 className="release-section-title">Changelog · correções</h4>
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
  const [designPro, setDesignPro] = useState(true);
  const [designDirection, setDesignDirection] = useState<DesignDirection>('auto');
  const [designVariance, setDesignVariance] = useState(5);
  const [designMotion, setDesignMotion] = useState(5);
  const [designDensity, setDesignDensity] = useState(5);

  useEffect(() => {
    void window.nexus.settings.orchGet().then((o) => {
      setLeanCode(o.leanCode);
      setSeniorMode(o.seniorMode);
      setDesignPro(o.designPro);
      setDesignDirection(o.designDirection ?? 'auto');
      setDesignVariance(o.designVariance ?? 5);
      setDesignMotion(o.designMotion ?? 5);
      setDesignDensity(o.designDensity ?? 5);
    });
  }, []);

  function openCreateEditor() {
    setFeedback(null);
    setEditing(createSquadDraft());
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

  const managementActions = (
    <div className="settings-squads__actions">
      <button
        type="button"
        className="settings-btn settings-btn--primary"
        onClick={openCreateEditor}
        disabled={operation !== null}
      >
        Criar squad
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
    <section>
      <SettingsSectionTitle>Squads</SettingsSectionTitle>
      <p className="settings-detail__hint">
        Defina como os especialistas trabalham e mantenha squads reutilizáveis
        sem sair das Configurações.
      </p>

      <OrchestratorDefaults />

      <MissionDriverSettings />

      <h4 className="settings-section-heading">Padrões de execução</h4>
      <div className="settings-toggle-list">
        <OrchestrationToggle
          checked={seniorMode}
          title="Disciplina sênior"
          detail="Exige stack correta, testes e lint verdes, revisão de segurança e documentação viva."
          onChange={(checked) => {
            setSeniorMode(checked);
            void window.nexus.settings.orchSet({ seniorMode: checked });
          }}
        />
        <OrchestrationToggle
          checked={designPro}
          title="Design profissional"
          detail="Aplica o design system do projeto, estados completos e revisão Impeccable em tarefas de UI."
          onChange={(checked) => {
            setDesignPro(checked);
            void window.nexus.settings.orchSet({ designPro: checked });
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
          <h4 className="settings-section-heading">
            Perfil de design (tarefas de UI)
          </h4>
          <p className="settings-detail__hint">
            Modula a carta de design injetada nos workers de UI. Dials no
            neutro e direção Auto não adicionam nada ao prompt; as proibições
            anti-genérico valem sempre.
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
            label="Intensidade de motion"
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

      <div className="settings-section-heading settings-section-heading--with-count">
        <h4>Squads salvos</h4>
        <span className="settings-chip">{visibleSquads.length}</span>
      </div>
      {visibleSquads.length === 0 ? (
        <EmptyState
          className="settings-squads__empty"
          icon="users"
          title="Nenhum squad salvo"
          body={
            <p>
              Crie uma equipe reutilizável ou importe um inventário de squads.
            </p>
          }
          action={managementActions}
        />
      ) : (
        <>
          {managementActions}
          <ul className="settings-list" aria-label="Squads salvos">
            {visibleSquads.map((squad) => {
              const deleting = operation === `delete:${squad.id}`;
              return (
                <li key={squad.id} className="settings-list__item">
                  <div className="settings-list__head settings-squads__row">
                    <span className="settings-list__title">{squad.name}</span>
                    <span className="settings-chip">
                      {squad.builtin ? 'original' : 'seu'}
                    </span>
                    <span className="settings-chip">
                      {squad.agents.length}{' '}
                      {squad.agents.length === 1 ? 'agente' : 'agentes'}
                    </span>
                    <div className="settings-squads__row-actions">
                      <button
                        type="button"
                        className="settings-btn"
                        disabled={operation !== null}
                        title={
                          squad.builtin
                            ? 'Criar uma cópia editável deste squad'
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
                        <button
                          type="button"
                          className="settings-btn settings-btn--danger"
                          disabled={operation !== null}
                          onClick={() => void deleteSavedSquad(squad)}
                        >
                          {deleting ? 'Apagando…' : 'Apagar'}
                        </button>
                      ) : null}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        </>
      )}
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
        Squads criados ou importados ficam disponíveis para novas missões. Os
        originais do Nexus continuam gerenciados pelo aplicativo.
      </p>
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
