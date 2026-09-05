import { useMemo } from 'react';
import type { WorkspaceInfo } from '../../shared/workspace-types';
import type { PanePickerEntry } from './PanePicker';
import { PixelIcon } from './PixelIcon';
import { ProviderLogo } from './ProviderLogo';

export const TERMINAL_LAYOUT_COUNTS = [1, 2, 3, 4, 6, 8, 10, 12] as const;
export const SHELL_ENTRY_ID = 'type:terminal';

/** Mirrors buildGridTree's alternating splits, including odd pane counts. */
function LayoutPreview({ count, depth = 0 }: { count: number; depth?: number }) {
  if (count === 1) return <span className="terminal-setup__preview-leaf" />;
  const half = Math.ceil(count / 2);
  return (
    <span className={`terminal-setup__preview-split terminal-setup__preview-split--${depth % 2 ? 'column' : 'row'}`}>
      <LayoutPreview count={half} depth={depth + 1} />
      <LayoutPreview count={count - half} depth={depth + 1} />
    </span>
  );
}

export function TerminalLayoutStep({ count, onCount, folder, onFolder, recents, onPickFolder }: {
  count: number;
  onCount(count: number): void;
  folder: string;
  onFolder(folder: string): void;
  recents: readonly WorkspaceInfo[];
  onPickFolder(): void;
}) {
  return (
    <>
      <section className="terminal-setup__section" aria-labelledby="terminal-folder-label">
        <label id="terminal-folder-label" htmlFor="terminal-folder" className="terminal-setup__label">Pasta do projeto</label>
        <p className="terminal-setup__hint">Escolha onde estão seus arquivos ou onde quer começar. Todos os painéis abrem nessa pasta.</p>
        <div className="terminal-setup__folder">
          <PixelIcon name="files" size={16} />
          <input id="terminal-folder" value={folder} readOnly placeholder="Escolha uma pasta de projeto" title={folder || 'Use Escolher pasta para selecionar o projeto'} />
          <button type="button" className="terminal-setup__quiet-button" onClick={onPickFolder} aria-label="Escolher pasta">
            <PixelIcon name="search" size={14} /><span>Escolher pasta</span>
          </button>
        </div>
      </section>
      <section className="terminal-setup__section" aria-labelledby="terminal-layout-label">
        <div className="terminal-setup__section-heading">
          <h3 id="terminal-layout-label">Quantos painéis você quer abrir?</h3>
          <span className="terminal-setup__count" aria-live="polite">{count} {count === 1 ? 'painel' : 'painéis'}</span>
        </div>
        <p className="terminal-setup__hint">Escolha como dividir a tela. <strong>Sem IA</strong> abre terminais para você digitar comandos; a próxima etapa permite escolher as IAs.</p>
        <div className="terminal-setup__layouts" role="group" aria-label="Layout dos terminais">
          {TERMINAL_LAYOUT_COUNTS.map(value => (
            <button type="button" key={value} className="terminal-setup__layout" aria-pressed={count === value} aria-label={`${value} ${value === 1 ? 'terminal' : 'terminais'}`} onClick={() => onCount(value)}>
              <span className="terminal-setup__preview" aria-hidden="true"><LayoutPreview count={value} /></span>
              <strong>{value}</strong>
            </button>
          ))}
        </div>
      </section>
      {recents.length > 0 && (
        <section className="terminal-setup__section" aria-labelledby="terminal-recents-label">
          <h3 id="terminal-recents-label" className="terminal-setup__label">Pastas recentes</h3>
          <div className="terminal-setup__recents">
            {recents.slice(0, 3).map(recent => (
              <button type="button" className="terminal-setup__recent" key={recent.path} onClick={() => onFolder(recent.path)} aria-pressed={folder === recent.path} title={recent.path}>
                <PixelIcon name="files" size={14} />
                <span><strong>{recent.name}</strong><small>{recent.path}</small></span>
                {folder === recent.path && <PixelIcon name="check" size={12} />}
              </button>
            ))}
          </div>
        </section>
      )}
    </>
  );
}

export function TerminalAgentsStep({ selections, entries, onSelect, onApplyAll, onConfigure }: {
  selections: readonly string[];
  entries: readonly PanePickerEntry[];
  onSelect(index: number, entryId: string): void;
  onApplyAll(): void;
  onConfigure(): void;
}) {
  const providers = useMemo(() => [...new Map(entries.filter(entry => entry.adapterId).map(entry => [entry.adapterId!, entry.group])).entries()], [entries]);
  return (
    <section className="terminal-setup__section" aria-label="IA por painel">
      <div className="terminal-setup__section-heading">
        <h3>Uma ferramenta para cada painel</h3>
        {selections.length > 1 && <button type="button" className="terminal-setup__quiet-button" onClick={onApplyAll}>Aplicar painel 1 a todos</button>}
      </div>
      <p className="terminal-setup__hint">Escolha uma ferramenta de IA ou mantenha <strong>Terminal sem IA</strong>. Modelo e conta aparecem depois de escolher a IA.</p>
      <div className="terminal-setup__agents">
        {selections.map((entryId, index) => {
          const selected = entries.find(entry => entry.id === entryId);
          const adapterId = selected?.adapterId ?? '';
          const models = entries.filter(entry => entry.adapterId === adapterId && entry.intent.kind === 'agent');
          return (
            <article className="terminal-setup__agent" key={index} data-has-agent={Boolean(adapterId)}>
              <header>
                <span className="terminal-setup__pane-number">{index + 1}</span>
                <strong>Painel {index + 1}</strong>
                {adapterId ? <ProviderLogo adapterId={adapterId} label={selected!.group} size="sm" /> : <PixelIcon name="terminal" size={16} />}
              </header>
              <label>Ferramenta
                <select aria-label={`Ferramenta do painel ${index + 1}`} value={selected ? adapterId : '__unavailable'} onChange={event => onSelect(index, entries.find(entry => entry.adapterId === event.target.value)?.id ?? SHELL_ENTRY_ID)}>
                  {!selected && <option value="__unavailable" disabled>Seleção indisponível</option>}
                  <option value="">Terminal sem IA</option>
                  {providers.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
                </select>
              </label>
              {adapterId ? (
                <label>Modelo e conta
                  <select aria-label={`Modelo e conta do painel ${index + 1}`} value={entryId} onChange={event => onSelect(index, event.target.value)}>
                    {models.map(entry => <option key={entry.id} value={entry.id}>{entry.detail} · {entry.label}</option>)}
                  </select>
                </label>
              ) : <p className="terminal-setup__shell-hint">{selected ? 'Você digita os comandos. Nenhuma IA será iniciada neste painel.' : 'Essa escolha não está mais disponível. Selecione outra ferramenta ou Terminal sem IA.'}</p>}
            </article>
          );
        })}
      </div>
      {providers.length === 0 && <p className="terminal-setup__hint" role="status">Nenhuma ferramenta de IA disponível ainda. Você pode abrir estes painéis sem IA ou <button type="button" className="terminal-setup__quiet-button" onClick={onConfigure}>Conectar uma IA</button>.</p>}
    </section>
  );
}

export function TerminalLaunchSummary({ folder, count, entries, selections }: {
  folder: string;
  count: number;
  entries: readonly PanePickerEntry[];
  selections?: readonly string[];
}) {
  const selected = selections?.map(id => entries.find(entry => entry.id === id));
  const withAi = selected?.filter(entry => entry?.intent.kind === 'agent').length ?? 0;
  const unavailable = selected?.filter(entry => !entry).length ?? 0;
  return (
    <section className="terminal-setup__summary" aria-label="Resumo da abertura">
      <div>
        <strong>{count} {count === 1 ? 'painel' : 'painéis'}</strong>
        {selected && <span>{withAi} com IA · {count - withAi - unavailable} sem IA{unavailable > 0 ? ` · ${unavailable} ${unavailable === 1 ? 'indisponível' : 'indisponíveis'}` : ''}</span>}
      </div>
      <p title={folder || undefined}><PixelIcon name="files" size={12} /><span>{folder || 'Escolha uma pasta para começar.'}</span></p>
    </section>
  );
}
