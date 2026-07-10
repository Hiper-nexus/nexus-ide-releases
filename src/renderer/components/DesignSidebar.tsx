import { useEffect, useMemo, useState } from 'react';
import type {
  DesignWritebackActionPayload,
  DesignMissionBindingPayload,
  DesignWritebackStatusPayload,
} from '../../shared/types';
import { listPanes } from '../lib/split-tree';
import { useDesignSelectionStore } from '../state/design-selection-store';
import { useLayoutStore } from '../state/layout-store';
import { useOrchStore } from '../state/orch-store';

type Props = {
  paneId: string;
};

/**
 * Design sidebar (VISUAL-EDIT-001, F2 — paridade Cursor 2.2): computed styles
 * do elemento selecionado, editáveis, com preview OTIMISTA na página
 * (design_set_style_preview) e "Aplicar" que envia o diff pro agente
 * persistir. O preview some sozinho quando o HMR entrega a mudança real
 * (MutationObserver no preload).
 */

const STYLE_GROUPS: Array<{ title: string; props: string[] }> = [
  {
    title: 'Espaçamento',
    props: [
      'padding-top',
      'padding-right',
      'padding-bottom',
      'padding-left',
      'margin-top',
      'margin-right',
      'margin-bottom',
      'margin-left',
    ],
  },
  {
    title: 'Tipografia',
    props: ['font-size', 'font-weight', 'line-height', 'letter-spacing', 'text-align'],
  },
  {
    title: 'Cores & borda',
    props: ['color', 'background-color', 'border-radius', 'opacity'],
  },
];

export function DesignSidebar({ paneId }: Props) {
  const selection = useDesignSelectionStore(
    (s) => s.byPane[paneId]?.selection ?? null,
  );
  /** prop → valor editado (ainda não persistido no código). */
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<string | null>(null);

  const rootNode = useLayoutStore((s) => s.root);
  const targetPaneId = useMemo(
    () => listPanes(rootNode).find((p) => p.kind === 'cli-agent')?.id ?? null,
    [rootNode],
  );
  const paneMissions = useOrchStore((s) => s.paneMissions);
  const writebackBinding = useMemo<DesignMissionBindingPayload | null>(() => {
    const missionPane = listPanes(rootNode).find(
      (pane) => pane.kind === 'cli-agent' && paneMissions[pane.id],
    );
    if (!missionPane) return null;
    return {
      browserPaneId: paneId,
      paneId: missionPane.id,
      missionId: paneMissions[missionPane.id],
    };
  }, [paneId, paneMissions, rootNode]);

  // Write-back determinístico (F3): status do workspace ativo.
  const [writeback, setWriteback] = useState<DesignWritebackStatusPayload | null>(
    null,
  );
  const [textDraft, setTextDraft] = useState('');

  async function refreshWriteback(): Promise<void> {
    try {
      const status = await window.nexus.design?.status(writebackBinding ?? undefined);
      if (status) setWriteback(status);
    } catch {
      setWriteback(null);
    }
  }

  // Nova seleção (ou seleção perdida) invalida o rascunho de edições e
  // re-checa o write-back (o usuário pode ter ativado a config no meio).
  useEffect(() => {
    setDraft({});
    setStatus(null);
    setTextDraft('');
    void refreshWriteback();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paneId, selection, writebackBinding]);

  if (!selection) return null;

  const baseline = selection.computedStyles;

  function commit(prop: string, rawValue: string): void {
    if (!selection) return;
    const value = rawValue.trim();
    const original = baseline[prop] ?? '';
    const next = { ...draft };
    if (!value || value === original) {
      delete next[prop];
    } else {
      next[prop] = value;
    }
    setDraft(next);
    if (value && value !== original) {
      void window.nexus.browser
        .setStylePreview(paneId, selection.selector, { [prop]: value })
        .catch((err) =>
          setStatus(err instanceof Error ? err.message : String(err)),
        );
    }
  }

  async function apply(): Promise<void> {
    if (!selection || !targetPaneId || !Object.keys(draft).length) return;
    setStatus('enviando…');
    try {
      const styleDiff = Object.fromEntries(
        Object.entries(draft).map(([prop, to]) => [
          prop,
          { from: baseline[prop] ?? '', to },
        ]),
      );
      await window.nexus.browser.sendDesignSelection(paneId, {
        targetPaneId,
        styleDiff,
      });
      setStatus('diff enviado pro agente ✓');
      setDraft({});
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
    }
  }

  async function revert(): Promise<void> {
    if (!selection) return;
    setDraft({});
    setStatus(null);
    try {
      await window.nexus.browser.clearStylePreview(paneId, selection.selector);
    } catch {
      // A dead pane has nothing to revert.
    }
  }

  const hasDraft = Object.keys(draft).length > 0;
  const nexusId = selection.attributes['data-nexus-id'] ?? null;

  async function runWriteback(
    operation: () => Promise<unknown>,
    okStatus: string,
  ): Promise<void> {
    setStatus('aplicando…');
    try {
      await operation();
      setStatus(okStatus);
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
    } finally {
      void refreshWriteback();
    }
  }

  function applyWriteback(action: DesignWritebackActionPayload): Promise<void> {
    if (!writebackBinding) {
      return Promise.resolve(setStatus(
        'Write-back direto exige um pane de missão PREVC em execução.',
      ));
    }
    return runWriteback(
      () => window.nexus.design.apply(writebackBinding, action),
      'gravado no código ✓',
    );
  }

  return (
    <aside className="design-sidebar nodrag" aria-label="Estilos do elemento">
      <div className="design-sidebar__head" title={selection.selector}>
        {selection.tag}
        {selection.id ? `#${selection.id}` : ''}
      </div>
      {STYLE_GROUPS.map((group) => {
        const visible = group.props.filter((prop) => prop in baseline);
        if (!visible.length) return null;
        return (
          <section key={group.title} className="design-sidebar__group">
            <h4 className="design-sidebar__group-title">{group.title}</h4>
            {visible.map((prop) => (
              <label key={prop} className="design-sidebar__field">
                <span className="design-sidebar__prop">{prop}</span>
                <input
                  data-style-prop={prop}
                  className="design-sidebar__input"
                  value={draft[prop] ?? baseline[prop]}
                  spellCheck={false}
                  onChange={(e) =>
                    setDraft((d) => ({ ...d, [prop]: e.target.value }))
                  }
                  onBlur={(e) => commit(prop, e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commit(prop, e.currentTarget.value);
                  }}
                />
              </label>
            ))}
          </section>
        );
      })}
      {writeback?.enabled && (
        <section className="design-sidebar__group design-sidebar__wb">
          <h4 className="design-sidebar__group-title">
            Write-back {writeback.active ? 'ON' : 'off'}
          </h4>
          {!writeback.active ? (
            <button
              type="button"
              data-testid="design-wb-start"
              className="design-sidebar__revert"
              disabled={!writebackBinding || writeback.authorityReady !== true}
              title="Instrumenta o projeto com IDs efêmeros (limpos ao parar)"
              onClick={() =>
                void runWriteback(
                  () => window.nexus.design.start(writebackBinding!),
                  'write-back ativo ✓',
                )
              }
            >
              Iniciar write-back
            </button>
          ) : (
            <>
              {writeback.authorityReady !== true && (
                <div className="design-sidebar__status" data-testid="design-wb-authority-error">
                  {writeback.authorityError ??
                    'Write-back direto exige uma missão PREVC em execução.'}
                </div>
              )}
              {nexusId && (
                <>
                  <button
                    type="button"
                    data-testid="design-apply-direct"
                    className="design-sidebar__apply"
                    disabled={!hasDraft || writeback.authorityReady !== true}
                    title="Grava o diff de estilos direto no código (sem agente)"
                    onClick={() =>
                      void applyWriteback({
                        kind: 'style',
                        nexusId,
                        styles: { ...draft },
                      }).then(() => setDraft({}))
                    }
                  >
                    Aplicar direto
                  </button>
                  <label className="design-sidebar__field">
                    <span className="design-sidebar__prop">texto</span>
                    <input
                      data-testid="design-text"
                      className="design-sidebar__input"
                      disabled={writeback.authorityReady !== true}
                      placeholder={selection.text.slice(0, 40)}
                      value={textDraft}
                      spellCheck={false}
                      onChange={(e) => setTextDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && textDraft.trim()) {
                          void applyWriteback({
                            kind: 'text',
                            nexusId,
                            text: textDraft.trim(),
                          });
                        }
                      }}
                    />
                  </label>
                  <div className="design-sidebar__actions">
                    <button
                      type="button"
                      data-testid="design-move-up"
                      className="design-sidebar__revert"
                      disabled={writeback.authorityReady !== true}
                      title="Mover para cima/esquerda entre os irmãos"
                      onClick={() =>
                        void applyWriteback({ kind: 'move', nexusId, direction: 'up' })
                      }
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      data-testid="design-move-down"
                      className="design-sidebar__revert"
                      disabled={writeback.authorityReady !== true}
                      title="Mover para baixo/direita entre os irmãos"
                      onClick={() =>
                        void applyWriteback({ kind: 'move', nexusId, direction: 'down' })
                      }
                    >
                      ↓
                    </button>
                    <button
                      type="button"
                      data-testid="design-duplicate"
                      className="design-sidebar__revert"
                      disabled={writeback.authorityReady !== true}
                      title="Duplicar o elemento"
                      onClick={() =>
                        void applyWriteback({ kind: 'duplicate', nexusId })
                      }
                    >
                      ⧉
                    </button>
                    <button
                      type="button"
                      data-testid="design-delete"
                      className="design-sidebar__revert"
                      disabled={writeback.authorityReady !== true}
                      title="Excluir o elemento"
                      onClick={() => void applyWriteback({ kind: 'delete', nexusId })}
                    >
                      🗑
                    </button>
                  </div>
                </>
              )}
              <div className="design-sidebar__actions">
                <button
                  type="button"
                  data-testid="design-undo"
                  className="design-sidebar__revert"
                  disabled={!writeback.canUndo || writeback.authorityReady !== true}
                  onClick={() =>
                    void runWriteback(
                      () => window.nexus.design.undo(writebackBinding!),
                      'desfeito ✓',
                    )
                  }
                >
                  ↶ desfazer
                </button>
                <button
                  type="button"
                  data-testid="design-redo"
                  className="design-sidebar__revert"
                  disabled={!writeback.canRedo || writeback.authorityReady !== true}
                  onClick={() =>
                    void runWriteback(
                      () => window.nexus.design.redo(writebackBinding!),
                      'refeito ✓',
                    )
                  }
                >
                  ↷ refazer
                </button>
                <button
                  type="button"
                  data-testid="design-wb-stop"
                  className="design-sidebar__revert"
                  title="Encerra a sessão e limpa os IDs efêmeros dos arquivos"
                  disabled={!writebackBinding || writeback.authorityReady !== true}
                  onClick={() =>
                    void runWriteback(
                      () => window.nexus.design.stop(writebackBinding!),
                      'write-back off',
                    )
                  }
                >
                  ■
                </button>
              </div>
            </>
          )}
        </section>
      )}
      <div className="design-sidebar__actions">
        <button
          type="button"
          data-testid="design-apply"
          className="design-sidebar__apply"
          disabled={!hasDraft || !targetPaneId}
          title={
            targetPaneId
              ? 'Enviar o diff de estilos pro agente persistir no código'
              : 'Abra um pane de agente CLI para aplicar'
          }
          onClick={() => void apply()}
        >
          Aplicar → agente
        </button>
        <button
          type="button"
          data-testid="design-revert"
          className="design-sidebar__revert"
          title="Descartar o preview e voltar aos estilos reais"
          onClick={() => void revert()}
        >
          Reverter
        </button>
      </div>
      {status && <div className="design-sidebar__status">{status}</div>}
    </aside>
  );
}
