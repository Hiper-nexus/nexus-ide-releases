import { useCallback, useEffect, useRef, useState } from 'react';
import type { CommandBlock } from '../../shared/command-block';
import { commandBlockSchema } from '../../shared/command-block';
import {
  commandSuggestionSchema,
  type CommandSuggestion,
  type CommandSuggestionScope,
} from '../../shared/command-refinery';
import {
  commandHistoryEntrySchema,
  type CommandHistoryEntry,
} from '../../shared/cli-history';
import { CLI_HISTORY_IMPORT_ACTION } from '../lib/action-names';
import {
  describeCliHistoryImport,
  importCliHistoryForPane,
} from '../lib/cli-history-import';
import { useToastStore } from '../state/toast-store';
import { getPaneSessionId, writeToPane } from '../terminal/terminal-host';
import { PixelIcon } from './PixelIcon';

export interface CommandBlockMenuProps {
  readonly paneId: string;
  readonly density?: 'full' | 'icons' | 'compact';
}

const SCOPE_LABEL: Readonly<Record<CommandSuggestionScope, string>> = {
  cwd: 'Neste diretório',
  project: 'Neste projeto',
  global: 'Histórico',
};

function parseBlocks(raw: unknown[]): CommandBlock[] {
  return raw.flatMap((item) => {
    const parsed = commandBlockSchema.safeParse(item);
    return parsed.success ? [parsed.data] : [];
  });
}

function parseSuggestions(raw: unknown[]): CommandSuggestion[] {
  return raw.flatMap((item) => {
    const parsed = commandSuggestionSchema.safeParse(item);
    return parsed.success ? [parsed.data] : [];
  });
}

const HISTORY_PAGE = 20;

type ImportState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'running' }
  | { readonly kind: 'done'; readonly summary: string }
  | { readonly kind: 'error'; readonly message: string };

function parseHistory(raw: unknown[]): CommandHistoryEntry[] {
  return raw.flatMap((item) => {
    const parsed = commandHistoryEntrySchema.safeParse(item);
    return parsed.success ? [parsed.data] : [];
  });
}

function statusLabel(status: CommandBlock['status']): string {
  if (status === 'success') return 'ok';
  if (status === 'failed') return 'falhou';
  if (status === 'running') return 'rodando';
  if (status === 'cancelled') return 'cancelado';
  return 'sem status';
}

export function CommandBlockMenu({
  paneId,
  density = 'full',
}: CommandBlockMenuProps) {
  const [open, setOpen] = useState(false);
  const [blocks, setBlocks] = useState<CommandBlock[]>([]);
  const [suggestions, setSuggestions] = useState<CommandSuggestion[]>([]);
  const [prefix, setPrefix] = useState('');
  const [busy, setBusy] = useState(false);
  const [blockError, setBlockError] = useState<string | null>(null);
  const [suggestionError, setSuggestionError] = useState<string | null>(null);
  const [history, setHistory] = useState<CommandHistoryEntry[]>([]);
  const [historyHasMore, setHistoryHasMore] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [importState, setImportState] = useState<ImportState>({ kind: 'idle' });
  const rootRef = useRef<HTMLDivElement>(null);
  const suggestionRequestRef = useRef(0);
  const historyRequestRef = useRef(0);
  const pushToast = useToastStore((state) => state.push);

  const refreshBlocks = useCallback(async () => {
    if (!window.nexus?.terminalBlock?.list) {
      setBlocks([]);
      setBlockError('Histórico de comandos indisponível');
      return;
    }
    const sessionId = getPaneSessionId(paneId) ?? undefined;
    const result = await window.nexus.terminalBlock.list({
      paneId,
      sessionId,
      limit: 8,
    });
    setBlockError(result.error ?? null);
    setBlocks(parseBlocks((result.blocks as unknown[]) ?? []));
  }, [paneId]);

  const refreshSuggestions = useCallback(
    async (nextPrefix: string) => {
      const requestId = suggestionRequestRef.current + 1;
      suggestionRequestRef.current = requestId;
      const sessionId = getPaneSessionId(paneId);
      if (!sessionId || !window.nexus?.terminalBlock?.suggest) {
        setSuggestions([]);
        setSuggestionError('Sugestões indisponíveis');
        return;
      }
      try {
        const result = await window.nexus.terminalBlock.suggest({
          sessionId,
          paneId,
          prefix: nextPrefix,
          limit: 8,
        });
        if (requestId !== suggestionRequestRef.current) return;
        setSuggestionError(result.error ?? null);
        setSuggestions(parseSuggestions(result.suggestions ?? []));
      } catch (cause) {
        if (requestId !== suggestionRequestRef.current) return;
        setSuggestions([]);
        setSuggestionError(
          cause instanceof Error ? cause.message : 'Sugestões indisponíveis',
        );
      }
    },
    [paneId],
  );

  /** F-1171: histórico persistido (SQLite) — importado + gravado. */
  const refreshHistory = useCallback(
    async (query: string, offset = 0) => {
      const requestId = historyRequestRef.current + 1;
      historyRequestRef.current = requestId;
      const sessionId = getPaneSessionId(paneId);
      if (!sessionId || !window.nexus?.terminalBlock?.searchHistory) {
        setHistory([]);
        setHistoryHasMore(false);
        return;
      }
      try {
        const result = await window.nexus.terminalBlock.searchHistory({
          sessionId,
          paneId,
          query,
          limit: HISTORY_PAGE,
          offset,
        });
        if (requestId !== historyRequestRef.current) return;
        const entries = parseHistory(result.entries ?? []);
        setHistoryError(result.error ?? null);
        setHistory((current) => (offset === 0 ? entries : [...current, ...entries]));
        setHistoryHasMore(result.hasMore === true);
      } catch (cause) {
        if (requestId !== historyRequestRef.current) return;
        setHistoryError(
          cause instanceof Error ? cause.message : 'Histórico indisponível',
        );
      }
    },
    [paneId],
  );

  const refreshAll = useCallback(async () => {
    setBusy(true);
    setBlockError(null);
    setSuggestionError(null);
    try {
      await Promise.all([
        refreshBlocks(),
        refreshSuggestions(prefix),
        refreshHistory(prefix),
      ]);
    } catch (cause) {
      setBlockError(
        cause instanceof Error ? cause.message : 'Falha ao atualizar',
      );
    } finally {
      setBusy(false);
    }
  }, [prefix, refreshBlocks, refreshHistory, refreshSuggestions]);

  useEffect(() => {
    if (!open) return;
    setBusy(true);
    setBlockError(null);
    setSuggestionError(null);
    setImportState({ kind: 'idle' });
    void Promise.all([
      refreshBlocks(),
      refreshSuggestions(''),
      refreshHistory(''),
    ])
      .catch((cause: unknown) => {
        setBlockError(
          cause instanceof Error ? cause.message : 'Falha ao atualizar',
        );
      })
      .finally(() => setBusy(false));
    const onDocumentPointer = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const onDocumentKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDocumentPointer);
    document.addEventListener('keydown', onDocumentKey);
    return () => {
      document.removeEventListener('mousedown', onDocumentPointer);
      document.removeEventListener('keydown', onDocumentKey);
    };
  }, [open, refreshBlocks, refreshHistory, refreshSuggestions]);

  async function importHistory() {
    setImportState({ kind: 'running' });
    const result = await importCliHistoryForPane(paneId);
    if (!result.ok || !result.counts) {
      setImportState({
        kind: 'error',
        message: result.error ?? 'Não foi possível importar o histórico',
      });
      return;
    }
    setImportState({
      kind: 'done',
      summary: describeCliHistoryImport(result.counts),
    });
    await refreshHistory(prefix);
  }

  async function copyHistoryCommand(entry: CommandHistoryEntry) {
    try {
      await navigator.clipboard.writeText(entry.command);
      pushToast('success', 'Copiado', entry.command.slice(0, 80));
    } catch {
      pushToast('warn', 'Comando', 'Não foi possível copiar');
    }
  }

  /** Cola no prompt do pane sem Enter: o operador revisa antes de rodar. */
  function insertHistoryCommand(entry: CommandHistoryEntry) {
    const sessionId = getPaneSessionId(paneId);
    if (!sessionId || !window.nexus?.pty) {
      pushToast('warn', 'Comando', 'Sessão indisponível');
      return;
    }
    // Mesma rota do teclado (`writeToPane`): escrita crua fire-and-forget é
    // recusada pelo main em pane governado e o comando sumia em silêncio
    // com o toast dizendo "Inserido no terminal".
    writeToPane(paneId, entry.command);
    pushToast('success', 'Inserido no terminal', entry.command.slice(0, 80));
    setOpen(false);
  }

  async function runBlockAction(
    action: 'copy_command' | 'copy_path' | 'rerun',
    block: CommandBlock,
  ) {
    try {
      const result = await window.nexus.terminalBlock.action({
        action,
        block: {
          id: block.id,
          sessionId: block.sessionId,
          paneId: block.paneId,
          workspaceId: block.workspaceId,
          missionId: block.missionId,
          command: block.command,
          cwd: block.cwd,
          projectRoot: block.projectRoot,
          shell: block.shell,
          status: block.status,
        },
      });
      if (!result.ok) {
        pushToast('warn', 'Comando', result.error ?? 'Ação recusada');
        return;
      }
      if (result.clipboardText && action.startsWith('copy_')) {
        try {
          await navigator.clipboard.writeText(result.clipboardText);
          pushToast('success', 'Copiado', result.clipboardText.slice(0, 80));
        } catch {
          pushToast('warn', 'Comando', 'Não foi possível copiar');
        }
      }
      if (action === 'rerun') {
        pushToast('success', 'Executando', block.command.slice(0, 80));
        setOpen(false);
      }
    } catch (cause) {
      pushToast(
        'warn',
        'Comando',
        cause instanceof Error ? cause.message : 'Ação recusada',
      );
    }
  }

  async function runSuggestion(suggestion: CommandSuggestion) {
    const sessionId = getPaneSessionId(paneId);
    if (!sessionId) {
      pushToast('warn', 'Comando', 'Sessão indisponível');
      return;
    }
    try {
      const result = await window.nexus.terminalBlock.runSuggestion({
        sessionId,
        paneId,
        command: suggestion.command,
        cwd: suggestion.cwd,
      });
      if (!result.ok) {
        pushToast('warn', 'Comando', result.error ?? 'Execução recusada');
        return;
      }
      pushToast('success', 'Executando', suggestion.command.slice(0, 80));
      setOpen(false);
    } catch (cause) {
      pushToast(
        'warn',
        'Comando',
        cause instanceof Error ? cause.message : 'Execução recusada',
      );
    }
  }

  async function dismissSuggestion(suggestion: CommandSuggestion) {
    const sessionId = getPaneSessionId(paneId);
    if (!sessionId) {
      pushToast('warn', 'Comando', 'Sessão indisponível');
      return;
    }
    try {
      const result = await window.nexus.terminalBlock.dismiss({
        sessionId,
        paneId,
        command: suggestion.command,
        cwd: suggestion.cwd,
      });
      if (!result.ok) {
        pushToast(
          'warn',
          'Comando',
          result.error ?? 'Não foi possível dispensar',
        );
        return;
      }
      suggestionRequestRef.current += 1;
      setSuggestions((current) =>
        current.filter(
          (item) =>
            item.command !== suggestion.command || item.cwd !== suggestion.cwd,
        ),
      );
    } catch (cause) {
      pushToast(
        'warn',
        'Comando',
        cause instanceof Error ? cause.message : 'Não foi possível dispensar',
      );
    }
  }

  return (
    <div className="cmd-blocks nodrag" ref={rootRef}>
      <button
        type="button"
        className="toolbar__btn"
        aria-label="Comandos do terminal"
        aria-haspopup="dialog"
        aria-expanded={open}
        data-tip="Histórico inteligente de comandos"
        onClick={(event) => {
          event.stopPropagation();
          if (!open) setPrefix('');
          setOpen(!open);
        }}
      >
        <PixelIcon name="blocks" size={11} />
        {density === 'full' && <span className="toolbar__btn-label">Cmds</span>}
      </button>
      {open && (
        <div
          className="cmd-blocks__menu"
          role="dialog"
          aria-label="Histórico de comandos"
          data-testid="command-block-menu"
        >
          <header className="cmd-blocks__head">
            <div>
              <strong>Refinador de comandos</strong>
              <span>frequência · sucesso · recência</span>
            </div>
            <button
              type="button"
              className="cmd-blocks__refresh"
              onClick={() => void refreshAll()}
              disabled={busy}
            >
              {busy ? 'Atualizando…' : 'Atualizar'}
            </button>
          </header>

          <label className="cmd-blocks__search">
            <PixelIcon name="search" size={11} />
            <input
              value={prefix}
              aria-label="Filtrar comandos"
              placeholder="Digite para refinar…"
              autoComplete="off"
              spellCheck={false}
              autoFocus
              onChange={(event) => {
                const nextPrefix = event.currentTarget.value;
                setPrefix(nextPrefix);
                void refreshSuggestions(nextPrefix);
                void refreshHistory(nextPrefix);
              }}
            />
          </label>

          {(suggestionError || blockError) && (
            <p className="cmd-blocks__error">
              {suggestionError ?? blockError}
            </p>
          )}

          {suggestions.length > 0 && (
            <section className="cmd-refinery" aria-label="Sugestões ranqueadas">
              <div className="cmd-blocks__section-title">Sugestões</div>
              <ul className="cmd-refinery__list">
                {suggestions.map((suggestion) => (
                  <li
                    key={JSON.stringify([suggestion.cwd, suggestion.command])}
                    className="cmd-refinery__item"
                    data-scope={suggestion.scope}
                  >
                    <button
                      type="button"
                      className="cmd-refinery__run"
                      aria-label={`Executar sugestão: ${suggestion.command}`}
                      onClick={() => void runSuggestion(suggestion)}
                    >
                      <span className="cmd-refinery__scope">
                        {SCOPE_LABEL[suggestion.scope]}
                      </span>
                      <code title={suggestion.command}>{suggestion.command}</code>
                      <span className="cmd-refinery__meta">
                        {suggestion.totalCount}× ·{' '}
                        {Math.round(suggestion.successRate * 100)}% sucesso
                      </span>
                    </button>
                    <button
                      type="button"
                      className="cmd-refinery__dismiss"
                      aria-label={`Dispensar sugestão: ${suggestion.command}`}
                      data-tip="Dispensar até o próximo uso"
                      onClick={() => void dismissSuggestion(suggestion)}
                    >
                      <PixelIcon name="close" size={10} />
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section aria-label="Comandos recentes">
            <div className="cmd-blocks__section-title">Recentes</div>
            {!blockError && blocks.length === 0 && (
              <p className="cmd-blocks__empty">
                Os próximos comandos concluídos aparecerão aqui.
              </p>
            )}
            <ul className="cmd-blocks__list">
              {blocks.map((block) => (
                <li key={block.id} className="cmd-blocks__item">
                  <div className="cmd-blocks__row">
                    <span
                      className={`cmd-blocks__status cmd-blocks__status--${block.status}`}
                    >
                      {statusLabel(block.status)}
                    </span>
                    <code className="cmd-blocks__cmd" title={block.command}>
                      {block.command || '(vazio)'}
                    </code>
                  </div>
                  <div className="cmd-blocks__actions" role="group">
                    <button
                      type="button"
                      onClick={() => void runBlockAction('copy_command', block)}
                    >
                      Copiar
                    </button>
                    <button
                      type="button"
                      onClick={() => void runBlockAction('copy_path', block)}
                    >
                      Diretório
                    </button>
                    <button
                      type="button"
                      disabled={block.status === 'running' || !block.command.trim()}
                      onClick={() => void runBlockAction('rerun', block)}
                    >
                      Executar
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </section>

          <section className="cmd-history" aria-label="Histórico persistido">
            <div className="cmd-history__head">
              <div className="cmd-blocks__section-title">Histórico</div>
              <button
                type="button"
                className="cmd-blocks__refresh cmd-history__import"
                aria-label={CLI_HISTORY_IMPORT_ACTION.accessibleName}
                data-tip={CLI_HISTORY_IMPORT_ACTION.description}
                disabled={importState.kind === 'running'}
                onClick={() => void importHistory()}
              >
                {importState.kind === 'running'
                  ? 'Importando…'
                  : CLI_HISTORY_IMPORT_ACTION.label}
              </button>
            </div>
            {importState.kind !== 'idle' && (
              <p
                className={`cmd-history__status cmd-history__status--${importState.kind}`}
                data-testid="cli-history-import-status"
                role={importState.kind === 'error' ? 'alert' : 'status'}
              >
                {importState.kind === 'running' && 'Importando…'}
                {importState.kind === 'done' && importState.summary}
                {importState.kind === 'error' && importState.message}
              </p>
            )}
            {historyError && <p className="cmd-blocks__error">{historyError}</p>}
            {!historyError && history.length === 0 && (
              <p className="cmd-blocks__empty">
                {prefix.trim()
                  ? 'Nada no histórico com esse filtro.'
                  : 'Sem comandos gravados ainda. Importe o histórico das CLIs deste projeto.'}
              </p>
            )}
            <ul className="cmd-blocks__list">
              {history.map((entry) => {
                const multiline = /[\r\n]/.test(entry.command);
                return (
                  <li key={entry.id} className="cmd-blocks__item">
                    <div className="cmd-blocks__row">
                      <span
                        className={`cmd-history__origin cmd-history__origin--${entry.origin}`}
                      >
                        {entry.origin === 'imported' ? 'importado' : 'gravado'}
                      </span>
                      <code className="cmd-blocks__cmd" title={entry.command}>
                        {entry.command || '(vazio)'}
                      </code>
                    </div>
                    <div className="cmd-blocks__actions" role="group">
                      <button
                        type="button"
                        aria-label={`Copiar comando: ${entry.command}`}
                        onClick={() => void copyHistoryCommand(entry)}
                      >
                        Copiar
                      </button>
                      <button
                        type="button"
                        aria-label={`Inserir no terminal: ${entry.command}`}
                        data-tip={
                          multiline
                            ? 'Comando de várias linhas: use Copiar'
                            : 'Cola no prompt sem Enter'
                        }
                        disabled={multiline || !entry.command.trim()}
                        onClick={() => insertHistoryCommand(entry)}
                      >
                        Inserir
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
            {historyHasMore && (
              <button
                type="button"
                className="cmd-blocks__refresh cmd-history__more"
                onClick={() => void refreshHistory(prefix, history.length)}
              >
                Mais antigos
              </button>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
