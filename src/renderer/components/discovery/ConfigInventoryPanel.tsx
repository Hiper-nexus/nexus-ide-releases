import { useCallback, useEffect, useRef, useState } from 'react';
import { EmptyState } from '../ActionCard';
import { PixelIcon, type PixelIconName } from '../PixelIcon';
import { useConfigInventoryStore } from '../../state/config-inventory-store';
import {
  buildConfigInventoryView,
  levelLabel,
  sourceLabel,
  type ConfigInventoryView,
  type InventoryCategoryId,
  type InventoryCategoryView,
  type InventoryItemView,
} from './config-inventory-view';

/**
 * Inventário de configs de agente descobertas no workspace — "o que cada CLI
 * enxerga aqui". Agrupa por categoria (MCP servers / rules & context / skills /
 * commands) com o ecossistema de origem como chip e o nível (user/project);
 * homônimos de fontes diferentes acendem como shadowing (precedência).
 *
 * Read-only: lê window.nexus.discovery.workspaceConfigs() (canal
 * discovery:workspace-configs). Segredos de env/headers já chegam mascarados do
 * main e não são exibidos. Densidade calma, teclado (Esc fecha), reduced-motion
 * pela CSS, estado vazio narrativo com prontidão.
 */

const CATEGORY_ICON: Record<InventoryCategoryId, PixelIconName> = {
  mcpServers: 'bolt',
  contextFiles: 'files',
  skills: 'sparkle',
  commands: 'terminal',
};

type LoadState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; view: ConfigInventoryView };

const CloseIcon = () => (
  <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
    <path
      d="M2.5 2.5 L9.5 9.5 M9.5 2.5 L2.5 9.5"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
    />
  </svg>
);

function ItemRow({ item }: { item: InventoryItemView }) {
  return (
    <li
      className={`config-inv__item${item.shadowed ? ' config-inv__item--shadowed' : ''}`}
    >
      <div className="config-inv__item-head">
        <span className="config-inv__item-name" title={item.name}>
          {item.name}
        </span>
        <span className="config-inv__chip" title={`Ecossistema: ${sourceLabel(item.source)}`}>
          {sourceLabel(item.source)}
        </span>
        <span
          className={`config-inv__chip config-inv__chip--level config-inv__chip--${item.level}`}
        >
          {levelLabel(item.level)}
        </span>
        {item.shadowed && (
          <span
            className="config-inv__chip config-inv__chip--shadow"
            title="Mesmo nome em mais de uma fonte/nível — a de maior precedência vence"
          >
            shadow
          </span>
        )}
      </div>
      {item.detail && (
        <p className="config-inv__item-detail" title={item.detail}>
          {item.detail}
        </p>
      )}
      <p className="config-inv__item-path" title={item.path}>
        {item.path}
      </p>
    </li>
  );
}

function CategoryBlock({ category }: { category: InventoryCategoryView }) {
  if (category.items.length === 0) return null;
  return (
    <section className="config-inv__category" aria-label={category.label}>
      <header className="config-inv__category-head">
        <span className="config-inv__category-icon" aria-hidden="true">
          <PixelIcon name={CATEGORY_ICON[category.id]} size={13} />
        </span>
        <span className="config-inv__category-label">{category.label}</span>
        <span className="config-inv__category-count">{category.items.length}</span>
        {category.shadowedNames > 0 && (
          <span
            className="config-inv__category-shadow"
            title={`${category.shadowedNames} nome(s) com shadowing entre fontes`}
          >
            {category.shadowedNames} shadow
          </span>
        )}
      </header>
      <ul className="config-inv__items">
        {category.items.map((item) => (
          <ItemRow key={`${item.source}:${item.path}`} item={item} />
        ))}
      </ul>
    </section>
  );
}

/**
 * Botão de abrir/fechar o inventário — plugável na WorkspaceBar ou no App.
 * Fica com aria-pressed espelhando o estado para leitores de tela.
 */
export function ConfigInventoryToggle({ className }: { className?: string }) {
  const open = useConfigInventoryStore((s) => s.open);
  const toggle = useConfigInventoryStore((s) => s.toggle);
  return (
    <button
      type="button"
      className={`config-inv-toggle${open ? ' config-inv-toggle--active' : ''}${className ? ` ${className}` : ''}`}
      onClick={toggle}
      aria-pressed={open}
      title="Configs descobertas neste workspace (MCP, rules, skills, commands)"
    >
      <PixelIcon name="config" size={14} />
      <span className="config-inv-toggle__label">Configs</span>
    </button>
  );
}

export function ConfigInventoryPanel() {
  const open = useConfigInventoryStore((s) => s.open);
  const close = useConfigInventoryStore((s) => s.close);
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const [refreshing, setRefreshing] = useState(false);
  const asideRef = useRef<HTMLElement | null>(null);

  const load = useCallback(async () => {
    setRefreshing(true);
    try {
      const raw = await window.nexus.discovery.workspaceConfigs();
      setState({ status: 'ready', view: buildConfigInventoryView(raw) });
    } catch (cause) {
      setState({
        status: 'error',
        message: cause instanceof Error ? cause.message : String(cause),
      });
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    void load();
  }, [open, load]);

  // Foca o painel ao abrir para que Esc/tab funcionem sem clique prévio.
  useEffect(() => {
    if (open) asideRef.current?.focus();
  }, [open]);

  if (!open) return null;

  const view = state.status === 'ready' ? state.view : null;
  const isEmpty = view !== null && view.totalItems === 0;

  return (
    <aside
      ref={asideRef}
      className="config-inv"
      aria-label="Inventário de configs do workspace"
      tabIndex={-1}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          close();
        }
      }}
    >
      <header className="config-inv__header">
        <span className="config-inv__title">Configs do workspace</span>
        <button
          className="config-inv__btn config-inv__icon-btn"
          onClick={() => void load()}
          disabled={refreshing}
          title="Revarrer o workspace"
          aria-label="Atualizar inventário"
        >
          <PixelIcon name="update" size={13} />
        </button>
        <button
          className="config-inv__btn config-inv__icon-btn"
          onClick={close}
          aria-label="Fechar inventário de configs"
        >
          <CloseIcon />
        </button>
      </header>

      {view?.workspaceRoot && (
        <p className="config-inv__root" title={view.workspaceRoot}>
          {view.workspaceRoot}
        </p>
      )}

      <div className="config-inv__body">
        {state.status === 'loading' && (
          <p className="config-inv__status" role="status">
            Varrendo o workspace…
          </p>
        )}

        {state.status === 'error' && (
          <EmptyState
            className="config-inv__empty"
            icon="warn"
            title="Não deu para ler as configs"
            body={<p className="config-inv__error-msg">{state.message}</p>}
            action={
              <button className="config-inv__btn" onClick={() => void load()}>
                Tentar de novo
              </button>
            }
          />
        )}

        {view && isEmpty && (
          <EmptyState
            className="config-inv__empty"
            icon="config"
            title="Nenhuma config descoberta ainda"
            body={
              <p>
                Ao abrir um workspace com CLIs de agente, o que cada uma enxerga
                aqui — MCP servers, rules, skills e commands — aparece nesta
                lista, com a origem e a precedência. Nada encontrado neste
                diretório e no seu home.
              </p>
            }
            action={
              <button className="config-inv__btn" onClick={() => void load()}>
                Revarrer
              </button>
            }
          />
        )}

        {view && !isEmpty && (
          <>
            {view.categories.map((category) => (
              <CategoryBlock key={category.id} category={category} />
            ))}
            {view.warnings.length > 0 && (
              <details className="config-inv__warnings">
                <summary>
                  {view.warnings.length} aviso
                  {view.warnings.length === 1 ? '' : 's'} de leitura
                </summary>
                <ul>
                  {view.warnings.map((warning, i) => (
                    <li key={i}>{warning}</li>
                  ))}
                </ul>
              </details>
            )}
          </>
        )}
      </div>
    </aside>
  );
}
