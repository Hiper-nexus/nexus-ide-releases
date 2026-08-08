import type { AccountInfo } from '../../../shared/account-types';
import {
  SQUAD_AGENT_INSTRUCTIONS_MAX_CHARS,
  type SquadAgent,
} from '../../../shared/orch-types';
import type { ProviderSettingsInfo } from '../../../shared/provider-settings-types';
import type { AdapterInfo } from '../../../shared/types';
import { isAdapterModelAuthenticated } from '../../orch/mission-runtime-readiness';

const CATEGORY_LABELS: Record<SquadAgent['category'], string> = {
  orchestrator: 'Coordenação e revisão',
  executor: 'Execução',
  reviewer: 'Verificação independente',
  scout: 'Pesquisa',
  architect: 'Arquitetura',
};

const EFFORT_LABELS: Readonly<Record<string, string>> = {
  auto: 'Automático',
  none: 'Nenhum',
  minimal: 'Mínimo',
  low: 'Baixo',
  medium: 'Médio',
  high: 'Alto',
  xhigh: 'Muito alto',
  max: 'Máximo',
  ultra: 'Ultra',
};

export function missionEffortLabel(effort: string): string {
  return EFFORT_LABELS[effort.toLocaleLowerCase('en-US')] ?? effort;
}

interface MissionSetupRosterRowProps {
  agent: SquadAgent;
  candidates: readonly AdapterInfo[];
  providers: readonly ProviderSettingsInfo[];
  accounts: readonly AccountInfo[];
  issue: string | null;
  removable: boolean;
  onChange(next: SquadAgent): void;
  onRemove(): void;
}

export function readyModelForAdapter(input: {
  adapter: AdapterInfo;
  providers: readonly ProviderSettingsInfo[];
  accounts: readonly AccountInfo[];
  preferredModel?: string | null;
  preferredAccountId?: string | null;
}): string | null {
  const provider = input.providers.find(
    (item) => item.adapterId === input.adapter.id,
  );
  if (!provider) return null;
  const candidates = [
    input.preferredModel?.trim(),
    provider.defaultModel.trim(),
    input.adapter.models.default.trim(),
    ...provider.models,
  ].filter((model): model is string => Boolean(model));
  const seen = new Set<string>();
  for (const model of candidates) {
    if (seen.has(model)) continue;
    seen.add(model);
    if (
      isAdapterModelAuthenticated(
        input.adapter,
        input.providers,
        model,
        input.accounts,
        input.preferredAccountId,
      )
    ) {
      return model;
    }
  }
  return null;
}

export function MissionSetupRosterRow({
  agent,
  candidates,
  providers,
  accounts,
  issue,
  removable,
  onChange,
  onRemove,
}: MissionSetupRosterRowProps) {
  const selectedAdapter = candidates.find((item) => item.id === agent.cli) ?? null;
  const selectedProvider = providers.find(
    (item) => item.adapterId === agent.cli,
  );
  const readyModels = selectedAdapter
    ? (selectedProvider?.models ?? selectedAdapter.models.list).filter((model) =>
        isAdapterModelAuthenticated(
          selectedAdapter,
          providers,
          model,
          accounts,
        ),
      )
    : [];
  const currentModelIsReady = Boolean(
    agent.model && readyModels.includes(agent.model),
  );
  const effortOptions = selectedProvider?.efforts ?? [];
  const currentEffortIsListed = Boolean(
    agent.effort && effortOptions.includes(agent.effort),
  );
  const fieldSuffix = agent.id.replace(/[^a-z0-9_-]/giu, '-');

  return (
    <li className="mission-roster-row" data-state={issue ? 'needs-attention' : 'ready'}>
      <div className="mission-roster-row__summary">
        <div className="mission-roster-row__identity">
          <strong>{agent.agentName}</strong>
          <span>{CATEGORY_LABELS[agent.category]}</span>
        </div>
        <span className="mission-roster-row__status">
          {issue ? 'Precisa de ajuste' : 'Pronto'}
        </span>
        {removable && (
          <button
            type="button"
            className="mission-setup__button mission-setup__button--quiet"
            aria-label={`Remover ${agent.agentName}`}
            onClick={onRemove}
          >
            Remover {agent.agentName}
          </button>
        )}
      </div>

      {issue && (
        <p className="mission-setup__inline-error" role="status">
          {issue}
        </p>
      )}

      <details className="mission-setup__disclosure mission-roster-row__details">
        <summary>Instruções para {agent.agentName}</summary>
        <div className="mission-setup__field">
          <label htmlFor={`mission-instructions-${fieldSuffix}`}>
            Orientações específicas deste papel (opcional)
          </label>
          <textarea
            id={`mission-instructions-${fieldSuffix}`}
            value={agent.instructions ?? ''}
            rows={4}
            maxLength={SQUAD_AGENT_INSTRUCTIONS_MAX_CHARS}
            aria-describedby={`mission-instructions-hint-${fieldSuffix}`}
            onChange={(event) =>
              onChange({
                ...agent,
                ...(event.target.value
                  ? { instructions: event.target.value }
                  : { instructions: undefined }),
              })
            }
          />
          <span
            id={`mission-instructions-hint-${fieldSuffix}`}
            className="mission-setup__hint"
          >
            Até 4.096 caracteres. As instruções não concedem novas ferramentas
            nem permissões.
          </span>
        </div>
      </details>

      <details className="mission-setup__disclosure mission-roster-row__details">
        <summary>
          Configurações técnicas de {agent.agentName}
        </summary>
        <div className="mission-roster-row__technical-grid">
          <div className="mission-setup__field">
            <label htmlFor={`mission-role-${fieldSuffix}`}>Papel na equipe</label>
            <input
              id={`mission-role-${fieldSuffix}`}
              type="text"
              value={agent.agentName}
              maxLength={128}
              onChange={(event) =>
                onChange({ ...agent, agentName: event.target.value })
              }
            />
            <span className="mission-setup__hint">
              Nome curto que aparece na revisão.
            </span>
          </div>

          <div className="mission-setup__field">
            <label htmlFor={`mission-tool-${fieldSuffix}`}>
              Ferramenta de IA para {agent.agentName}
            </label>
            <select
              id={`mission-tool-${fieldSuffix}`}
              value={agent.cli}
              onChange={(event) => {
                const adapter = candidates.find(
                  (item) => item.id === event.target.value,
                );
                if (!adapter) return;
                const provider = providers.find(
                  (item) => item.adapterId === adapter.id,
                );
                const model = readyModelForAdapter({
                  adapter,
                  providers,
                  accounts,
                });
                onChange({
                  ...agent,
                  cli: adapter.id,
                  ...(model ? { model } : { model: undefined }),
                  ...(provider?.effort
                    ? { effort: provider.effort }
                    : { effort: undefined }),
                });
              }}
            >
              {!selectedAdapter && (
                <option value={agent.cli} disabled>
                  {agent.cli} (indisponível)
                </option>
              )}
              {candidates.map((adapter) => (
                <option key={adapter.id} value={adapter.id}>
                  {adapter.label}
                </option>
              ))}
            </select>
          </div>

          <div className="mission-setup__field">
            <label htmlFor={`mission-model-${fieldSuffix}`}>
              Modelo para {agent.agentName}
            </label>
            <select
              id={`mission-model-${fieldSuffix}`}
              value={agent.model ?? ''}
              onChange={(event) =>
                onChange({
                  ...agent,
                  ...(event.target.value
                    ? { model: event.target.value }
                    : { model: undefined }),
                })
              }
            >
              {!agent.model && <option value="">Escolha um modelo</option>}
              {agent.model && !currentModelIsReady && (
                <option value={agent.model} disabled>
                  {agent.model} (indisponível)
                </option>
              )}
              {readyModels.map((model) => (
                <option key={model} value={model}>
                  {model}
                </option>
              ))}
            </select>
          </div>

          <div className="mission-setup__field">
            <label htmlFor={`mission-effort-${fieldSuffix}`}>
              Esforço para {agent.agentName}
            </label>
            <select
              id={`mission-effort-${fieldSuffix}`}
              value={agent.effort ?? ''}
              onChange={(event) =>
                onChange({
                  ...agent,
                  ...(event.target.value
                    ? { effort: event.target.value }
                    : { effort: undefined }),
                })
              }
            >
              <option value="">Padrão da ferramenta</option>
              {agent.effort && !currentEffortIsListed && (
                <option value={agent.effort}>
                  {missionEffortLabel(agent.effort)}
                </option>
              )}
              {effortOptions.map((effort) => (
                <option key={effort} value={effort}>
                  {missionEffortLabel(effort)}
                </option>
              ))}
            </select>
          </div>
        </div>
      </details>
    </li>
  );
}
