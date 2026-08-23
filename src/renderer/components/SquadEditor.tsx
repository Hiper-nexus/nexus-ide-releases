import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Squad, AgentCategory } from '../../shared/orch-types';
import type { AdapterInfo } from '../../shared/adapter-types';
import { applySquadEdit, type EditableAgent } from '../../shared/squad-edit';
import { CloseButton } from './CloseButton';
import { PixelIcon } from './PixelIcon';
import { useFocusTrap } from '../lib/use-focus-trap';

const CATEGORIES: AgentCategory[] = [
  'orchestrator',
  'architect',
  'scout',
  'executor',
  'reviewer',
];

type Props = {
  squad: Squad;
  mode?: 'create' | 'edit';
  onClose: () => void;
  onSaved: (message: string) => void;
};

/**
 * Editor de squad. Squads de usuário são editados no lugar; builtins viram
 * uma cópia editável (a regra vive em applySquadEdit). Permite mudar nome,
 * instruções e, por agente, cli/model/categoria/nome.
 */
export function SquadEditor({
  squad,
  mode = 'edit',
  onClose,
  onSaved,
}: Props) {
  const [adapters, setAdapters] = useState<AdapterInfo[]>([]);
  const [name, setName] = useState(squad.name);
  const [instructions, setInstructions] = useState(squad.orchestratorInstructions);
  const [agents, setAgents] = useState<EditableAgent[]>(
    squad.agents.map((a) => ({ ...a })),
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const creating = mode === 'create';

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
  const nameInputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  // Tab preso no diálogo: sem isto o foco passeava pela app atrás do scrim.
  useFocusTrap(dialogRef, true);

  // Modal centralizado: foco entra no primeiro campo ao abrir (também faz o
  // Esc funcionar sem precisar clicar dentro antes).
  useEffect(() => {
    nameInputRef.current?.focus();
  }, []);

  function updateAgent(index: number, patch: Partial<EditableAgent>) {
    setAgents((prev) =>
      prev.map((a, i) => (i === index ? { ...a, ...patch } : a)),
    );
  }

  function modelsFor(cli: string): string[] {
    return adapters.find((a) => a.id === cli)?.models.list ?? [];
  }
  function requestClose() {
    if (!busy) onClose();
  }

  async function onSave() {
    setBusy(true);
    setError(null);
    try {
      const newId = squad.builtin ? `squad-${crypto.randomUUID()}` : squad.id;
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
        setError(result.error ?? 'Falha ao salvar o squad.');
        return;
      }
      onSaved(
        creating
          ? `Squad "${edited.name}" criado`
          : squad.builtin
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

  // Portal + scrim: o editor abria INLINE no fim da lista de squads — nascia
  // fora da viewport e o usuário tinha que rolar até ele (achado de
  // operador). Modal centralizado é o comportamento esperado de "Editar".
  return createPortal(
    <div
      className="squad-editor__scrim"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) requestClose();
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') requestClose();
      }}
    >
    <div
      className="squad-editor"
      role="dialog"
      ref={dialogRef}
      aria-modal="true"
      aria-label={creating ? 'Criar squad' : `Editar ${squad.name}`}
      aria-busy={busy}
    >
      <header className="squad-editor__head">
        <strong>
          {creating
            ? 'Criar squad'
            : squad.builtin
              ? 'Duplicar e personalizar'
              : 'Editar squad'}
        </strong>
        <CloseButton onClick={requestClose} label="Fechar editor" />
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
          ref={nameInputRef}
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
          <PixelIcon name="warn" size={11} /> {error}
        </p>
      )}
      <div className="squad-editor__actions">
        <button
          type="button"
          className="settings-btn"
          onClick={requestClose}
          disabled={busy}
        >
          Cancelar
        </button>
        <button
          type="button"
          className="settings-btn settings-btn--primary"
          onClick={() => void onSave()}
          disabled={busy || !name.trim()}
        >
          {busy ? 'Salvando…' : squad.builtin ? 'Criar cópia' : 'Salvar'}
        </button>
      </div>
    </div>
    </div>,
    document.body,
  );
}
