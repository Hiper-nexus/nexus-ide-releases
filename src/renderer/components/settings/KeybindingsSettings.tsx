// Adapted from pingdotgg/t3code @ 26285ab80513260d1ff29d2c3fbe18f21990cb62
// Copyright (c) 2026 T3 Tools Inc. — MIT License
// See third_party/licenses/t3code-MIT.txt. Nexus changes: editor de linha do T3 (settings/KeybindingsSettings.tsx:692-850 — pílula que vira captura, Esc cancela, salvar só com rascunho; aviso de conflito :267-279; "Reset to default" :890-934 e :1462-1485) reescrito sem Base UI/Tailwind, nos tokens e classes de Configurações do Nexus, em PT-BR; sem editor de `when` (os contextos são fixos por comando); captura, validação e conflito vêm de lib/keybindings; persistência em `ui.keybindings` via settings-store.
import { useEffect, useRef, useState } from 'react';
import {
  bindingFromEvent,
  effectiveBindings,
  formatBinding,
  keybindingConflicts,
  keybindingDefinition,
  KEYBINDING_COMMANDS,
  type BindingResult,
  type KeybindingCommand,
} from '../../lib/keybindings';
import { useSettingsStore } from '../../state/settings-store';

const FLEET_COMMANDS = new Set<KeybindingCommand>([
  'focus-pane-n',
  'split-right',
  'split-down',
  'stage-focus',
  'close-pane',
]);

/** O `when` de cada comando em linguagem de operador. */
const WHEN_HINTS: Readonly<Record<string, string>> = {
  hasWorkspace: 'Com um projeto aberto.',
  'hasWorkspace && !terminalFocus': 'Com um projeto aberto, fora do terminal.',
  'hasWorkspace && projectOverview': 'Com um projeto aberto.',
  paneFocused: 'Com um terminal selecionado.',
  'paneFocused && terminalFocus': 'Dentro do terminal selecionado.',
};

interface Draft {
  readonly command: KeybindingCommand;
  readonly result: BindingResult;
}

function KeybindingRow({
  command,
  recording,
  draft,
  saving,
  onRecord,
  onCapture,
  onStopRecording,
  onCancel,
  onSave,
  onReset,
}: {
  command: KeybindingCommand;
  recording: boolean;
  draft: Draft | null;
  saving: boolean;
  onRecord(): void;
  onCapture(result: BindingResult): void;
  /** Sai da gravação sem tocar no rascunho (blur, Esc). */
  onStopRecording(): void;
  onCancel(): void;
  onSave(value: string): void;
  onReset(): void;
}) {
  const overrides = useSettingsStore((state) => state.ui.keybindings);
  const definition = keybindingDefinition(command);
  const bindings = effectiveBindings(command, overrides);
  const customized = Array.isArray(overrides[command]);
  const conflicts =
    draft?.result.ok === true
      ? keybindingConflicts(command, draft.result.value, overrides)
      : [];
  const labelId = `keybinding-${command}`;
  // Gravação encerrada pelo teclado (Esc ou captura): o foco volta à próxima
  // ação da linha em vez de cair no <body>. Blur (clique fora) não puxa foco.
  const actionsRef = useRef<HTMLSpanElement>(null);
  const refocusRef = useRef(false);
  useEffect(() => {
    if (recording || !refocusRef.current) return;
    refocusRef.current = false;
    actionsRef.current?.querySelector('button')?.focus();
  }, [recording, draft]);

  return (
    <li className="settings-list__item keybinding-row" data-command={command}>
      <div className="settings-list__head">
        <span className="keybinding-row__label">
          <span id={labelId} className="settings-list__detail">
            {definition.label}
          </span>
          {definition.when && WHEN_HINTS[definition.when] ? (
            <span className="keybinding-row__when">
              {WHEN_HINTS[definition.when]}
            </span>
          ) : null}
        </span>
        <span className="keybinding-row__keys">
          {recording ? (
            <button
              type="button"
              className="keybinding-row__capture"
              autoFocus
              aria-describedby={labelId}
              aria-label={`Gravando atalho para ${definition.label}. Pressione a combinação; Esc cancela.`}
              onBlur={onStopRecording}
              onKeyDown={(event) => {
                // Tab sai da gravação (blur cancela) — foco nunca fica preso.
                if (event.key === 'Tab') return;
                // Nada do que é gravado pode virar atalho do app ao mesmo tempo.
                event.preventDefault();
                event.stopPropagation();
                if (event.key === 'Escape') {
                  refocusRef.current = true;
                  onStopRecording();
                  return;
                }
                const result = bindingFromEvent(command, event.nativeEvent);
                if (!result) return;
                refocusRef.current = true;
                onCapture(result);
              }}
            >
              Pressione a combinação…
            </button>
          ) : draft?.result.ok ? (
            <kbd className="catalog-kbd">
              {formatBinding(draft.result.value, command)}
            </kbd>
          ) : bindings.length > 0 ? (
            bindings.map((binding) => (
              <kbd key={binding} className="catalog-kbd">
                {formatBinding(binding, command)}
              </kbd>
            ))
          ) : (
            <span className="keybinding-row__none">Sem atalho</span>
          )}
        </span>
        <span className="keybinding-row__actions" ref={actionsRef}>
          {draft ? (
            <>
              {draft.result.ok ? (
                <button
                  type="button"
                  className="settings-btn settings-btn--primary"
                  disabled={saving}
                  onClick={() => draft.result.ok && onSave(draft.result.value)}
                >
                  {saving ? 'Salvando…' : 'Salvar'}
                </button>
              ) : (
                <button type="button" className="settings-btn" onClick={onRecord}>
                  Tentar de novo
                </button>
              )}
              <button type="button" className="settings-btn" onClick={onCancel}>
                Cancelar
              </button>
            </>
          ) : recording ? null : (
            <>
              <button
                type="button"
                className="settings-btn"
                aria-label={`Alterar atalho: ${definition.label}`}
                onClick={onRecord}
              >
                Alterar
              </button>
              {customized ? (
                <button
                  type="button"
                  className="settings-btn"
                  aria-label={`Restaurar padrão: ${definition.label}`}
                  disabled={saving}
                  onClick={onReset}
                >
                  Restaurar padrão
                </button>
              ) : null}
            </>
          )}
        </span>
      </div>
      {draft && !draft.result.ok ? (
        <p className="keybinding-row__error" role="alert">
          {draft.result.error}
        </p>
      ) : null}
      {conflicts.length > 0 ? (
        <p className="keybinding-row__warn" role="status">
          Conflita com{' '}
          {conflicts.map((id) => keybindingDefinition(id).label).join(', ')}.
          Salvando, esta combinação passa a abrir {definition.label}.
        </p>
      ) : null}
    </li>
  );
}

/** Configurações › Atalhos: gravar, ver conflito e restaurar o padrão. */
export function KeybindingsEditor() {
  const overrides = useSettingsStore((state) => state.ui.keybindings);
  const updateUi = useSettingsStore((state) => state.updateUi);
  const [recording, setRecording] = useState<KeybindingCommand | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const persist = async (next: Record<string, string[]>) => {
    setSaving(true);
    setSaveError(null);
    try {
      await updateUi({ keybindings: next });
      setDraft(null);
    } catch {
      setSaveError('Não consegui salvar os atalhos. Tente de novo.');
    } finally {
      setSaving(false);
    }
  };

  const save = (command: KeybindingCommand, value: string) =>
    void persist({ ...overrides, [command]: [value] });

  const reset = (command: KeybindingCommand) => {
    const next = { ...overrides };
    delete next[command];
    void persist(next);
  };

  const row = (command: KeybindingCommand) => (
    <KeybindingRow
      key={command}
      command={command}
      recording={recording === command}
      draft={draft?.command === command ? draft : null}
      saving={saving}
      onRecord={() => {
        setDraft(null);
        setRecording(command);
      }}
      onCapture={(result) => {
        setRecording(null);
        setDraft({ command, result });
      }}
      onStopRecording={() =>
        setRecording((current) => (current === command ? null : current))
      }
      onCancel={() =>
        setDraft((current) => (current?.command === command ? null : current))
      }
      onSave={(value) => save(command, value)}
      onReset={() => reset(command)}
    />
  );

  const command = KEYBINDING_COMMANDS.filter((def) => !FLEET_COMMANDS.has(def.id));
  const fleet = KEYBINDING_COMMANDS.filter((def) => FLEET_COMMANDS.has(def.id));

  return (
    <div className="keybindings-editor">
      {saveError ? (
        <p className="keybinding-row__error" role="alert">
          {saveError}
        </p>
      ) : null}
      <div className="arsenal-band">
        <h3 className="arsenal-band__label">
          Comando
          <span className="arsenal-band__count">{command.length}</span>
        </h3>
        <ul className="settings-list">{command.map((def) => row(def.id))}</ul>
      </div>
      <div className="arsenal-band">
        <h3 className="arsenal-band__label">
          Frota
          <span className="arsenal-band__count">{fleet.length}</span>
        </h3>
        <ul className="settings-list">{fleet.map((def) => row(def.id))}</ul>
      </div>
      {Object.keys(overrides).length > 0 ? (
        <button
          type="button"
          className="settings-btn keybindings-editor__reset-all"
          disabled={saving}
          onClick={() => void persist({})}
        >
          Restaurar todos os padrões
        </button>
      ) : null}
    </div>
  );
}
