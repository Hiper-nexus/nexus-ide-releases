import { useEffect, useMemo, useState } from 'react';
import type { Squad, AgentCategory } from '../../shared/orch-types';
import type { AdapterInfo } from '../../shared/adapter-types';
import { applySquadEdit, type EditableAgent } from '../../shared/squad-edit';
import { CloseButton } from './CloseButton';

const CATEGORIES: AgentCategory[] = [
  'orchestrator',
  'architect',
  'scout',
  'executor',
  'reviewer',
];

type Props = {
  squad: Squad;
  onClose: () => void;
  onSaved: (message: string) => void;
};

/**
 * Editor de squad. Squads de usuário são editados no lugar; builtins viram
 * uma cópia editável (a regra vive em applySquadEdit). Permite mudar nome,
 * instruções e, por agente, cli/model/categoria/nome.
 */
export function SquadEditor({ squad, onClose, onSaved }: Props) {
  const [adapters, setAdapters] = useState<AdapterInfo[]>([]);
  const [name, setName] = useState(squad.name);
  const [instructions, setInstructions] = useState(squad.orchestratorInstructions);
  const [agents, setAgents] = useState<EditableAgent[]>(
    squad.agents.map((a) => ({ ...a })),
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void window.nexus.adapters
      .list()
      .then((list) => {
        if (!cancelled) setAdapters(list);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const installed = useMemo(() => adapters.filter((a) => a.installed), [adapters]);

  function updateAgent(index: number, patch: Partial<EditableAgent>) {
    setAgents((prev) =>
      prev.map((a, i) => (i === index ? { ...a, ...patch } : a)),
    );
  }

  function modelsFor(cli: string): string[] {
    return adapters.find((a) => a.id === cli)?.models.list ?? [];
  }

  async function onSave() {
    setBusy(true);
    setError(null);
    try {
      const newId = `squad-${crypto.randomUUID()}`;
      const edited = applySquadEdit(
        {
          id: squad.id,
          name: squad.name,
          createdAt: squad.createdAt,
          builtin: squad.builtin,
          orchestratorInstructions: squad.orchestratorInstructions,
          nativeInstructions: squad.nativeInstructions,
          agents: squad.agents.map((a) => ({ ...a })),
        },
        { name, orchestratorInstructions: instructions, agents },
        newId,
      );
      const result = await window.nexus.orch.saveSquad(edited as Squad);
      if (!result.ok) {
        setError(result.error ?? 'falha ao salvar');
        return;
      }
      onSaved(
        squad.builtin
          ? `Cópia editável de "${squad.name}" criada`
          : `Squad "${edited.name}" atualizado`,
      );
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="squad-editor"
      role="dialog"
      aria-modal="true"
      aria-label={`Editar ${squad.name}`}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onClose();
      }}
    >
      <header className="squad-editor__head">
        <strong>
          {squad.builtin ? 'Duplicar e personalizar' : 'Editar squad'}
        </strong>
        <CloseButton onClick={onClose} label="Fechar editor" />
      </header>
      {squad.builtin && (
        <p className="squad-editor__hint">
          Este é um squad interno (gerenciado pelo app). Salvar cria uma cópia
          sua, editável e preservada entre atualizações.
        </p>
      )}
      <label className="squad-editor__field">
        Nome
        <input
          className="squad-editor__input"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </label>
      <label className="squad-editor__field">
        Instruções do orquestrador
        <textarea
          className="squad-editor__textarea"
          value={instructions}
          rows={4}
          onChange={(e) => setInstructions(e.target.value)}
        />
      </label>
      <div className="squad-editor__roster">
        <span className="squad-editor__roster-label">Agentes</span>
        {agents.map((agent, index) => (
          <div className="squad-editor__agent" key={agent.id}>
            <input
              className="squad-editor__input squad-editor__input--name"
              value={agent.agentName}
              aria-label="Nome do agente"
              onChange={(e) => updateAgent(index, { agentName: e.target.value })}
            />
            <select
              className="squad-editor__input"
              value={agent.category}
              aria-label="Categoria"
              onChange={(e) =>
                updateAgent(index, { category: e.target.value as AgentCategory })
              }
            >
              {CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
            <select
              className="squad-editor__input"
              value={agent.cli}
              aria-label="CLI"
              onChange={(e) => {
                const cli = e.target.value;
                const models = modelsFor(cli);
                updateAgent(index, { cli, model: models[0] });
              }}
            >
              {installed.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.id}
                </option>
              ))}
              {!installed.some((a) => a.id === agent.cli) && (
                <option value={agent.cli}>{agent.cli} (não instalado)</option>
              )}
            </select>
            <select
              className="squad-editor__input"
              value={agent.model ?? ''}
              aria-label="Modelo"
              onChange={(e) => updateAgent(index, { model: e.target.value })}
            >
              {modelsFor(agent.cli).map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
              {agent.model && !modelsFor(agent.cli).includes(agent.model) && (
                <option value={agent.model}>{agent.model}</option>
              )}
            </select>
          </div>
        ))}
      </div>
      {error && (
        <p className="squad-editor__error" role="alert">
          ⚠ {error}
        </p>
      )}
      <div className="squad-editor__actions">
        <button className="orch-panel__btn" onClick={onClose} disabled={busy}>
          Cancelar
        </button>
        <button
          className="orch-panel__btn orch-panel__btn--primary"
          onClick={() => void onSave()}
          disabled={busy || !name.trim()}
        >
          {squad.builtin ? 'Criar cópia' : 'Salvar'}
        </button>
      </div>
    </div>
  );
}
