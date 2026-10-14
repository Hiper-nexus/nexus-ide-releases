import { useState } from 'react';
import type { AccountInfo } from '../../../shared/account-types';
import {
  SQUAD_AGENT_INSTRUCTIONS_MAX_CHARS,
  type SquadAgent,
} from '../../../shared/orch-types';
import type { ProviderSettingsInfo } from '../../../shared/provider-settings-types';
import type { AdapterInfo } from '../../../shared/types';
import { isAdapterModelAuthenticated } from '../../orch/mission-runtime-readiness';
import { rankPickerModels } from '../../lib/pane-picker-models';
import { PixelIcon } from '../PixelIcon';

const CATEGORY_LABELS: Record<SquadAgent['category'], string> = {
  orchestrator: 'Coordenação e revisão',
  executor: 'Execução',
  reviewer: 'Verificação independente',
  scout: 'Pesquisa',
  architect: 'Arquitetura',
};

// Efforts em INGLÊS, como as próprias CLIs mostram (low/medium/high/xhigh):
// traduzir criava dois vocabulários para o mesmo botão — o operador via
// "Muito alto" aqui e "xhigh" no rodapé do pane (pedido do operador, 19/08).
const EFFORT_LABELS: Readonly<Record<string, string>> = {
  auto: 'Auto',
  none: 'None',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'XHigh',
  max: 'Max',
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
  /** Expresso: Ferramenta/Modelo visíveis, sem o bloco de instruções. */
  compact?: boolean;
  onChange(next: SquadAgent): void;
  onRemove(): void;
}

export function readyModelsForPicker(input: {
  adapter: Pick<AdapterInfo, 'models'> | null;
  provider:
    | (Pick<ProviderSettingsInfo, 'models'> &
        Partial<Pick<ProviderSettingsInfo, 'defaultModel' | 'modelInfo'>>)
    | undefined;
}): string[] {
  const merged = [
    ...new Set([
      ...(input.provider?.models ?? []),
      ...(input.adapter?.models.list ?? []),
    ]),
  ];
  if (!input.provider) return merged;
  // Mesma régua do "+ Pane": mais forte primeiro, api-only marcado mas
  // rankeado pela força, deprecated por último.
  return rankPickerModels({
    models: merged,
    defaultModel: input.provider.defaultModel ?? '',
    modelInfo: input.provider.modelInfo,
  }).map((row) => row.id);
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
  compact = false,
  onChange,
  onRemove,
}: MissionSetupRosterRowProps) {
  const selectedAdapter = candidates.find((item) => item.id === agent.cli) ?? null;
  const selectedProvider = providers.find(
    (item) => item.adapterId === agent.cli,
  );
  const readyModels = readyModelsForPicker({
    adapter: selectedAdapter,
    provider: selectedProvider,
  });
  // CLI que não projeta esforços não pode virar um select vazio ("só Padrão"):
  // o operador escolhe pela escada universal e o spawn aplica exatamente o que
  // foi escolhido — personalização acima de paternalismo.
  const FALLBACK_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
  const effortOptions =
    selectedProvider?.efforts?.length
      ? selectedProvider.efforts
      : FALLBACK_EFFORTS;
  const currentEffortIsListed = Boolean(
    agent.effort && effortOptions.includes(agent.effort),
  );
  const fieldSuffix = agent.id.replace(/[^a-z0-9_-]/giu, '-');
  const issueId = `mission-roster-issue-${fieldSuffix}`;

  const [customModel, setCustomModel] = useState(false);

  const handleToolChange = (nextCliId: string): void => {
    const adapter = candidates.find((item) => item.id === nextCliId);
    if (!adapter) return;
    const provider = providers.find((item) => item.adapterId === adapter.id);
    const model = readyModelForAdapter({ adapter, providers, accounts });
    onChange({
      ...agent,
      cli: adapter.id,
      ...(model ? { model } : { model: undefined }),
      ...(provider?.effort ? { effort: provider.effort } : { effort: undefined }),
    });
  };

  return (
    <li
      className={
        compact
          ? 'mission-roster-row mission-roster-row--compact'
          : 'mission-roster-row'
      }
      data-state={issue ? 'needs-attention' : 'ready'}
      data-category={agent.category}
    >
      <div className="mission-roster-row__card">
        <div className="mission-roster-row__summary">
          <span
            className="mission-roster-row__avatar"
            aria-hidden="true"
            data-category={agent.category}
          >
            {agent.category === 'orchestrator'
              ? '♛'
              : agent.category === 'reviewer'
                ? '◎'
                : agent.category === 'scout'
                  ? '⌕'
                  : agent.category === 'architect'
                    ? '⬡'
                    : '⚒'}
          </span>
          <div className="mission-roster-row__identity">
            <strong>{agent.agentName}</strong>
            <span className="mission-roster-row__meta">
              <span className="mission-roster-row__role">
                {CATEGORY_LABELS[agent.category]}
              </span>
            </span>
            {/* Personalização direta no cartão: escolher CLI e digitar QUALQUER
                modelo (sugestões do catálogo via datalist) sem caçar menus. */}
            <div className="mission-roster-row__controls">
              <label className="mission-roster-row__control">
                <span>Ferramenta</span>
                <select
                  aria-label={`Ferramenta de IA para ${agent.agentName}`}
                  aria-describedby={issue ? issueId : undefined}
                  value={agent.cli}
                  onChange={(event) => handleToolChange(event.target.value)}
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
              </label>
              <label className="mission-roster-row__control mission-roster-row__control--model">
                <span>Modelo</span>
                {customModel ? (
                  <input
                    type="text"
                    aria-label={`Modelo para ${agent.agentName}`}
                    value={agent.model ?? ''}
                    placeholder="digite o id do modelo"
                    spellCheck={false}
                    autoFocus
                    onChange={(event) =>
                      onChange({
                        ...agent,
                        ...(event.target.value.trim()
                          ? { model: event.target.value }
                          : { model: undefined }),
                      })
                    }
                    onBlur={() => {
                      if (readyModels.includes(agent.model ?? '')) {
                        setCustomModel(false);
                      }
                    }}
                  />
                ) : (
                  /* Datalist filtrava as sugestões pelo texto já preenchido e
                     parecia catálogo de 2 modelos. Select mostra o catálogo
                     INTEIRO sempre; a última opção abre digitação livre. */
                  <select
                    aria-label={`Modelo para ${agent.agentName}`}
                    value={agent.model ?? ''}
                    onChange={(event) => {
                      if (event.target.value === '__custom__') {
                        setCustomModel(true);
                        return;
                      }
                      onChange({
                        ...agent,
                        ...(event.target.value
                          ? { model: event.target.value }
                          : { model: undefined }),
                      });
                    }}
                  >
                    <option value="">Padrão da ferramenta</option>
                    {agent.model && !readyModels.includes(agent.model) && (
                      <option value={agent.model}>{agent.model} (custom)</option>
                    )}
                    {readyModels.map((model) => (
                      <option key={model} value={model}>
                        {model}
                      </option>
                    ))}
                    <option value="__custom__">Digitar outro modelo…</option>
                  </select>
                )}
              </label>
              <label className="mission-roster-row__control">
                <span>Esforço</span>
                <select
                  aria-label={`Esforço do modelo para ${agent.agentName}`}
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
                  <option value="">Padrão</option>
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
              </label>
            </div>
          </div>
          {!compact && (
          <span className="mission-roster-row__status">
            {issue ? 'Precisa de ajuste' : 'Pronto'}
          </span>
          )}
          {/* Só o ícone: o nome do papel já está no cartão, e um texto longo
              empurrava o estado e quebrava a fila de controles. O nome
              acessível e a dica carregam "Remover <papel>". */}
          {removable && (
            <button
              type="button"
              className="mission-setup__button mission-setup__button--quiet mission-roster-row__remove"
              aria-label={`Remover ${agent.agentName}`}
              title={`Remover ${agent.agentName}`}
              onClick={onRemove}
            >
              <PixelIcon name="trash" size={12} />
            </button>
          )}
        </div>

        {issue && (
          <p id={issueId} className="mission-setup__inline-error" role="status">
            {issue}
          </p>
        )}

        {!compact && (
          <div className="mission-roster-row__more">
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

              </div>
            </details>
          </div>
        )}
      </div>
    </li>
  );
}
