import { useCallback, useEffect, useMemo, useRef } from 'react';
import {
  MEMORY_KIND_LABELS,
  MEMORY_UI_KINDS,
  MEMORY_SCOPE_LABELS,
  type MemoryUiBankStats,
  type MemoryUiHit,
  type MemoryUiKind,
} from '../../../shared/memory-ui-types';
import { useMemoryStore } from '../../state/memory-store';
import { EmptyState } from '../ActionCard';
import { PixelIcon } from '../PixelIcon';
import './memory-panel.css';

/**
 * Painel de memória agentic por workspace (entrega C2). Drawer à direita, na
 * mesma gramática do orch-panel / omp-panel: denso em sinal, calmo em ruído,
 * neon (acento) só no que está VIVO. Mostra os stats do banco, uma busca
 * debounced (recall FTS5) e o estado vazio/desligado com prontidão.
 *
 * Teclado: a busca é o foco primário — Enter dispara o recall imediato, ↑/↓
 * navegam os resultados, Esc limpa a busca (ou fecha o painel se já vazia).
 */

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

function formatWhen(ts: number): string {
  const date = new Date(ts);
  const now = Date.now();
  const diffMs = now - ts;
  const day = 86_400_000;
  if (diffMs >= 0 && diffMs < day && date.getDate() === new Date(now).getDate()) {
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  return date.toLocaleDateString([], { day: '2-digit', month: 'short' });
}

function ImportancePips({ value }: { value: number }) {
  const clamped = Math.max(1, Math.min(5, value));
  return (
    <span
      className="memory-hit__importance"
      aria-label={`importância ${clamped} de 5`}
      title={`importância ${clamped}/5`}
    >
      {[1, 2, 3, 4, 5].map((level) => (
        <span
          key={level}
          className={`memory-hit__pip ${level <= clamped ? 'memory-hit__pip--on' : ''}`}
          aria-hidden="true"
        />
      ))}
    </span>
  );
}

function bankTotals(bank: MemoryUiBankStats): string {
  return `${bank.active} ativa${bank.active === 1 ? '' : 's'}`;
}

function StatsBlock({
  label,
  bank,
}: {
  label: string;
  bank: MemoryUiBankStats;
}) {
  const kinds = MEMORY_UI_KINDS.filter((kind) => bank.byKind[kind] > 0);
  return (
    <div className="memory-stats__bank">
      <div className="memory-stats__bank-head">
        <span className="memory-stats__scope">{label}</span>
        <span className="memory-stats__count">{bankTotals(bank)}</span>
      </div>
      {kinds.length > 0 ? (
        <ul className="memory-stats__kinds" aria-label={`memórias por tipo (${label})`}>
          {kinds.map((kind) => (
            <li key={kind} className="memory-stats__kind">
              <span className="memory-stats__kind-label">
                {MEMORY_KIND_LABELS[kind]}
              </span>
              <span className="memory-stats__kind-count">{bank.byKind[kind]}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="memory-stats__empty">sem registros</p>
      )}
      {bank.totalRecalls > 0 && (
        <p className="memory-stats__recalls">
          {bank.totalRecalls} recall{bank.totalRecalls === 1 ? '' : 's'}
        </p>
      )}
    </div>
  );
}

function MemoryHitRow({
  hit,
  active,
  onForget,
  onFocus,
  registerRef,
}: {
  hit: MemoryUiHit;
  active: boolean;
  onForget: (id: string) => void;
  onFocus: () => void;
  registerRef: (el: HTMLLIElement | null) => void;
}) {
  return (
    <li
      ref={registerRef}
      className={`memory-hit ${active ? 'memory-hit--active' : ''}`}
      role="option"
      aria-selected={active}
      onMouseEnter={onFocus}
    >
      <div className="memory-hit__head">
        <span className={`memory-hit__kind memory-hit__kind--${hit.kind}`}>
          {MEMORY_KIND_LABELS[hit.kind]}
        </span>
        <span className={`memory-hit__scope memory-hit__scope--${hit.scope}`}>
          {MEMORY_SCOPE_LABELS[hit.scope]}
        </span>
        <ImportancePips value={hit.importance} />
        <button
          type="button"
          className="memory-hit__forget"
          title="Esquecer esta memória (fica auditável, sai do recall)"
          aria-label="Esquecer memória"
          onClick={() => onForget(hit.id)}
        >
          <CloseIcon />
        </button>
      </div>
      <p className="memory-hit__content">{hit.content}</p>
      <div className="memory-hit__meta">
        {hit.source && (
          <span className="memory-hit__source" title={hit.source}>
            {hit.source}
          </span>
        )}
        <span className="memory-hit__when">{formatWhen(hit.updatedAt)}</span>
      </div>
    </li>
  );
}

export function MemoryPanel() {
  const panelOpen = useMemoryStore((s) => s.panelOpen);
  const enabled = useMemoryStore((s) => s.enabled);
  const stats = useMemoryStore((s) => s.stats);
  const query = useMemoryStore((s) => s.query);
  const kindFilter = useMemoryStore((s) => s.kindFilter);
  const recalling = useMemoryStore((s) => s.recalling);
  const results = useMemoryStore((s) => s.results);
  const resultsQuery = useMemoryStore((s) => s.resultsQuery);
  const activeIndex = useMemoryStore((s) => s.activeIndex);
  const error = useMemoryStore((s) => s.error);

  const closePanel = useMemoryStore((s) => s.closePanel);
  const setQuery = useMemoryStore((s) => s.setQuery);
  const setKindFilter = useMemoryStore((s) => s.setKindFilter);
  const runRecallNow = useMemoryStore((s) => s.runRecallNow);
  const moveActive = useMemoryStore((s) => s.moveActive);
  const setActive = useMemoryStore((s) => s.setActive);
  const forget = useMemoryStore((s) => s.forget);

  const inputRef = useRef<HTMLInputElement>(null);
  const activeRef = useRef<HTMLLIElement | null>(null);

  useEffect(() => {
    if (panelOpen) inputRef.current?.focus();
  }, [panelOpen]);

  useEffect(() => {
    if (activeIndex >= 0) {
      activeRef.current?.scrollIntoView({ block: 'nearest' });
    }
  }, [activeIndex]);

  const onInputKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        void runRecallNow();
      } else if (event.key === 'ArrowDown') {
        event.preventDefault();
        moveActive(1);
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        moveActive(-1);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        if (query) setQuery('');
        else closePanel();
      }
    },
    [closePanel, moveActive, query, runRecallNow, setQuery],
  );

  const totalActive = useMemo(() => {
    if (!stats) return null;
    return stats.workspace.active + stats.global.active;
  }, [stats]);

  const bankIsEmpty =
    stats !== null && stats.workspace.active === 0 && stats.global.active === 0;
  const trimmedQuery = query.trim();
  const showNoResults =
    enabled !== false &&
    trimmedQuery.length > 0 &&
    !recalling &&
    results.length === 0 &&
    resultsQuery === trimmedQuery;

  if (!panelOpen) return null;

  return (
    <aside className="memory-panel" aria-label="Memória do workspace">
      <header className="memory-panel__header">
        <span className="memory-panel__title">Memória</span>
        {enabled === true && totalActive !== null && (
          <span className="memory-panel__summary">
            {totalActive} memória{totalActive === 1 ? '' : 's'}
          </span>
        )}
        <button
          type="button"
          className="memory-panel__icon-btn"
          onClick={closePanel}
          aria-label="Fechar painel de memória"
        >
          <CloseIcon />
        </button>
      </header>

      {enabled === false ? (
        <div className="memory-panel__body">
          <EmptyState
            className="memory-panel__empty"
            icon="key"
            title="Memória desligada"
            body={
              <>
                <p>
                  A memória agentic por workspace está desativada. Ligue a flag{' '}
                  <code className="memory-panel__flag">
                    feature.memory.workspaceMemory
                  </code>{' '}
                  para os agentes começarem a registrar e recuperar fatos aqui.
                </p>
              </>
            }
          />
        </div>
      ) : (
        <>
          <div className="memory-panel__search">
            <PixelIcon name="search" size={14} />
            <input
              ref={inputRef}
              className="memory-panel__input"
              type="search"
              value={query}
              placeholder="Buscar memórias…"
              aria-label="Buscar memórias"
              spellCheck={false}
              autoComplete="off"
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={onInputKeyDown}
            />
            {recalling && (
              <span className="memory-panel__spinner" aria-hidden="true" />
            )}
          </div>

          <div
            className="memory-panel__filters"
            role="group"
            aria-label="Filtrar por tipo"
          >
            <button
              type="button"
              className={`memory-filter ${kindFilter === null ? 'memory-filter--active' : ''}`}
              onClick={() => setKindFilter(null)}
            >
              todos
            </button>
            {MEMORY_UI_KINDS.map((kind: MemoryUiKind) => (
              <button
                key={kind}
                type="button"
                className={`memory-filter ${kindFilter === kind ? 'memory-filter--active' : ''}`}
                onClick={() => setKindFilter(kindFilter === kind ? null : kind)}
              >
                {MEMORY_KIND_LABELS[kind]}
              </button>
            ))}
          </div>

          <div className="memory-panel__body">
            {error && <p className="memory-panel__error">{error}</p>}

            {stats && (
              <section className="memory-stats" aria-label="Estatísticas de memória">
                <StatsBlock label="workspace" bank={stats.workspace} />
                <StatsBlock label="global" bank={stats.global} />
              </section>
            )}

            {trimmedQuery.length === 0 ? (
              bankIsEmpty ? (
                <EmptyState
                  className="memory-panel__empty"
                  icon="sparkle"
                  title="Nenhuma memória ainda"
                  body={
                    <p>
                      Este workspace ainda não tem memórias. Conforme os agentes
                      trabalham, eles vão registrar aqui fatos, decisões e
                      preferências para lembrar depois.
                    </p>
                  }
                />
              ) : (
                <EmptyState
                  className="memory-panel__empty"
                  icon="search"
                  title="Busque para lembrar"
                  body={
                    <p>
                      Digite um termo para recuperar memórias deste workspace (e do
                      banco global) por relevância, importância e recência.
                    </p>
                  }
                />
              )
            ) : showNoResults ? (
              <EmptyState
                className="memory-panel__empty"
                icon="search"
                title="Nada encontrado"
                body={
                  <p>
                    Nenhuma memória casou <strong>{trimmedQuery}</strong>. Tente
                    outros termos ou remova o filtro de tipo.
                  </p>
                }
              />
            ) : (
              <ul
                className="memory-hits"
                role="listbox"
                aria-label="Resultados da busca de memória"
              >
                {results.map((hit, index) => (
                  <MemoryHitRow
                    key={hit.id}
                    hit={hit}
                    active={index === activeIndex}
                    onForget={forget}
                    onFocus={() => setActive(index)}
                    registerRef={(el) => {
                      if (index === activeIndex) activeRef.current = el;
                    }}
                  />
                ))}
              </ul>
            )}
          </div>
        </>
      )}
    </aside>
  );
}
