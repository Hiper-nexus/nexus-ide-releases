import type { AdapterInfo } from '../../shared/types';
import type { Squad, SquadAgent } from '../../shared/orch-types';
import type { ProviderSettingsInfo } from '../../shared/provider-settings-types';
import { defaultSquadModelForAdapter } from '../../shared/squad-model-defaults';
import { AgentAvatar } from './AgentAvatar';
import { ProviderLogo } from './ProviderLogo';
import { ModelMetaBadge } from './model/ModelMetaBadge';

/**
 * Etapa REVISAR do Mission Wizard — roster editável (CLI/modelo/effort +
 * allowlists de tools/skills por agente). Extraída do MissionWizard para
 * manter os módulos abaixo do teto de 800 linhas; todo o estado continua no
 * wizard pai e chega por props (componente 100% apresentacional).
 */

interface MissionWizardReviewProps {
  squad: Squad;
  roster: SquadAgent[];
  adapters: AdapterInfo[];
  providers?: ProviderSettingsInfo[];
  highlightedAgentId: string | null;
  error: string | null;
  spawning: boolean;
  rosterSaved: boolean;
  rosterInvalidAgent: SquadAgent | null;
  onSaveRoster(): void;
  onUpdateAgent(id: string, patch: Partial<SquadAgent>): void;
  onError(message: string): void;
  onBack(): void;
  onCancel(): void;
  onLaunch(): void;
}

function specValue(list: string[] | null | undefined, isOrchestrator = false): string {
  if (list == null) return isOrchestrator ? '*' : 'vazio/bloqueado';
  return list.join(', ');
}

function parseSpecList(value: string, allowUnrestricted: boolean): string[] | null {
  const clean = value.trim();
  if (clean === '*') return allowUnrestricted ? null : [];
  if (!clean) return [];
  return clean
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

export function MissionWizardReview({
  squad,
  roster,
  adapters,
  providers = [],
  highlightedAgentId,
  error,
  spawning,
  rosterSaved,
  rosterInvalidAgent,
  onSaveRoster,
  onUpdateAgent,
  onError,
  onBack,
  onCancel,
  onLaunch,
}: MissionWizardReviewProps) {
  return (
    <div className="wizard__section">
      <div className="wizard__review-head">
        <p className="wizard__label">{squad.name}</p>
        <button
          className="wizard__btn"
          onClick={onSaveRoster}
          title="Salvar as mudanças de CLI/modelo/effort no squad"
        >
          {rosterSaved ? 'Salvo' : 'Salvar edições'}
        </button>
      </div>
      <p className="wizard__hint-sm">
        O orquestrador usa o provider padrão de Configurações. Workers entram
        balanceados entre os demais CLIs disponíveis e continuam editáveis.
      </p>
      <p className="wizard__hint-sm">
        Use * só no orquestrador; workers precisam de tools explícitas
        ou vazio. Gaps explícitos: gap:nome: motivo.
      </p>
      <ul className="wizard__roster wizard__roster--edit">
        {roster.map((a) => {
          const isOrchestrator = a.category === 'orchestrator';
          const cliAdapter = adapters.find((x) => x.id === a.cli);
          const orchestratorProviderReady = Boolean(
            cliAdapter?.installed && cliAdapter.orchestratorCapable,
          );
          const models = cliAdapter?.models.list ?? [];
          return (
            <li
              key={a.id}
              data-agent-id={a.id}
              className={`wizard__roster-row${a.id === highlightedAgentId ? ' wizard__roster-row--invalid' : ''}`}
            >
              <div className="wizard__agent-main">
                <div className="wizard__agent-identity">
                  <AgentAvatar
                    category={a.category}
                    state="offline"
                    size="card"
                    label={a.agentName}
                  />
                  <span className="wizard__roster-role">{a.category}</span>
                  <span className="wizard__roster-name" title={a.agentName}>
                    {a.agentName}
                  </span>
                </div>
                <div className="wizard__agent-controls">
                  <span className="wizard__provider-select">
                    <ProviderLogo
                      adapterId={a.cli}
                      label={cliAdapter?.label ?? a.cli}
                      fallback={cliAdapter?.icon}
                      size="xs"
                    />
                    {isOrchestrator ? (
                      <span
                        className="wizard__mini-select wizard__mini-select--locked"
                        title={
                          orchestratorProviderReady
                            ? 'Provider padrão do orquestrador. Altere em Configurações › Squads.'
                            : 'Provider indisponível para orquestração Nexus MCP. Altere em Configurações › Squads.'
                        }
                      >
                        {cliAdapter?.label ?? a.cli}
                        {orchestratorProviderReady ? '' : ' ⚠'}
                      </span>
                    ) : (
                      <select
                        className="wizard__mini-select"
                        value={a.cli}
                        onChange={(e) =>
                          onUpdateAgent(a.id, {
                            cli: e.target.value,
                            model: defaultSquadModelForAdapter(e.target.value),
                          })
                        }
                      >
                        {adapters.map((x) => (
                          <option key={x.id} value={x.id}>
                            {x.label}
                            {x.installed ? '' : ' ⚠'}
                          </option>
                        ))}
                        {!adapters.some((x) => x.id === a.cli) && (
                          <option value={a.cli}>{a.cli}</option>
                        )}
                      </select>
                    )}
                  </span>
                <div className="wizard__model-cell">
                  <select
                    className="wizard__mini-select"
                    value={a.model ?? cliAdapter?.models.default ?? ''}
                    onChange={(e) => onUpdateAgent(a.id, { model: e.target.value })}
                  >
                    {models.length === 0 && (
                      <option value={a.model ?? ''}>{a.model ?? '—'}</option>
                    )}
                    {models.map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                  </select>
                  <ModelMetaBadge
                    adapterId={a.cli}
                    modelId={a.model ?? cliAdapter?.models.default}
                    className="wizard__model-meta"
                  />
                </div>
                  <select
                    className="wizard__mini-select wizard__mini-select--effort"
                    value={a.effort ?? 'medium'}
                    onChange={(e) =>
                      onUpdateAgent(a.id, {
                        effort: e.target.value as SquadAgent['effort'],
                      })
                    }
                  >
                    {(() => {
                      const advertised = providers.find((p) => p.adapterId === a.cli)?.efforts ?? [];
                      const current = a.effort ?? 'medium';
                      const efforts = advertised.length > 0
                        ? [...new Set([...advertised, current])]
                        : [...new Set(['low', 'medium', 'high', 'xhigh', 'max', current])];
                      return efforts.map((effort) => (
                        <option key={effort} value={effort}>{effort}</option>
                      ));
                    })()}
                  </select>
                </div>
              </div>
              <div className="wizard__agent-spec">
                <label className="wizard__agent-spec-label">
                  tools
                  <input
                    className={`wizard__agent-spec-input${!isOrchestrator && a.allowedTools == null ? ' wizard__agent-spec-input--error' : ''}`}
                    value={specValue(a.allowedTools, isOrchestrator)}
                    placeholder={
                      isOrchestrator
                        ? '* (irrestrito) ou Bash, Read, Edit…'
                        : 'Bash, Read, Edit… (vazio = bloquear todas)'
                    }
                    spellCheck={false}
                    onChange={(e) => {
                      if (!isOrchestrator && e.target.value.trim() === '*') {
                        onError(
                          'Workers não podem usar * em tools; deixe vazio ou liste tools explícitas.',
                        );
                      }
                      onUpdateAgent(a.id, {
                        allowedTools: parseSpecList(
                          e.target.value,
                          isOrchestrator,
                        ),
                      });
                    }}
                  />
                </label>
                <label className="wizard__agent-spec-label">
                  skills
                  <input
                    className="wizard__agent-spec-input"
                    value={specValue(a.allowedSkills, true)}
                    placeholder="react-patterns, graphify… (vazio = bloquear)"
                    spellCheck={false}
                    onChange={(e) =>
                      onUpdateAgent(a.id, {
                        allowedSkills: parseSpecList(e.target.value, true),
                      })
                    }
                  />
                </label>
                {!isOrchestrator && a.allowedTools == null && (
                  <p className="wizard__row-error">
                    Tools bloqueadas. Liste explicitamente ou deixe vazio para bloquear todas.
                  </p>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      {error && <p className="wizard__error">{error}</p>}
      <div className="wizard__actions">
        <button className="wizard__btn" onClick={onBack}>
          ‹ Voltar
        </button>
        <div className="wizard__actions-right">
          <button className="wizard__btn wizard__btn--ghost" onClick={onCancel}>
            Cancelar
          </button>
          <button
            className="wizard__btn wizard__btn--primary"
            onClick={onLaunch}
            disabled={spawning || !!rosterInvalidAgent}
            title={
              rosterInvalidAgent
                ? `Worker "${rosterInvalidAgent.agentName}" está sem allowlist de tools. Corrija o campo "tools" antes de iniciar.`
                : undefined
            }
          >
            {spawning ? 'Iniciando…' : 'Iniciar Squad'}
          </button>
        </div>
      </div>
    </div>
  );
}
