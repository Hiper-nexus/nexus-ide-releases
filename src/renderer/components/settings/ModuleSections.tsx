import { useState } from 'react';
import type { AdapterInfo } from '../../../shared/types';
import {
  TERMINAL_THEME_IDS,
  type TerminalThemeId,
} from '../../../shared/settings-types';
import { TERMINAL_THEMES } from '../../styles/terminal-theme';
import { useSettingsStore } from '../../state/settings-store';
import { useOrchStore } from '../../state/orch-store';
import { useVoiceStore } from '../../voice/voice-store';

/** MÓDULOS sections: Terminal, ClockVoice, Providers, Squads, Marketplace. */

export function TerminalSection() {
  const terminal = useSettingsStore((s) => s.terminal);
  const update = useSettingsStore((s) => s.update);

  return (
    <section>
      <h3 className="settings-detail__title">Terminal</h3>
      <p className="settings-detail__hint">
        Tema, fonte e shell aplicados ao vivo em todos os panes abertos.
      </p>

      <label className="settings-field">
        Tema
        <div className="settings-theme-grid">
          {TERMINAL_THEME_IDS.map((id: TerminalThemeId) => {
            const entry = TERMINAL_THEMES[id];
            return (
              <button
                key={id}
                className={`settings-theme ${terminal.themeId === id ? 'settings-theme--active' : ''}`}
                style={{
                  background: String(entry.theme.background),
                  color: String(entry.theme.foreground),
                }}
                onClick={() => void update({ themeId: id })}
              >
                {entry.label}
              </button>
            );
          })}
        </div>
      </label>

      <label className="settings-field">
        Fonte (vazio = padrão do sistema)
        <input
          className="settings-input"
          value={terminal.fontFamily}
          placeholder='ex.: "JetBrains Mono", monospace'
          onChange={(e) => void update({ fontFamily: e.target.value })}
        />
      </label>

      <label className="settings-field">
        Tamanho da fonte: {terminal.fontSize}px
        <input
          className="settings-range"
          type="range"
          min={9}
          max={24}
          value={terminal.fontSize}
          onChange={(e) => void update({ fontSize: Number(e.target.value) })}
        />
      </label>

      <label className="settings-field">
        Shell (caminho absoluto; vazio = $SHELL)
        <input
          className="settings-input"
          value={terminal.shell}
          placeholder="/bin/zsh"
          onChange={(e) => void update({ shell: e.target.value })}
        />
        <span className="settings-field__note">
          Vale para novos panes de shell — os já abertos continuam no shell
          atual.
        </span>
      </label>
    </section>
  );
}

export function ClockVoiceSection({ onNavigate }: { onNavigate: () => void }) {
  const openVoice = useVoiceStore((s) => s.openSettings);
  return (
    <section>
      <h3 className="settings-detail__title">ClockVoice</h3>
      <p className="settings-detail__hint">
        Voz e captura: push-to-talk, STT (Groq/whisper), tradução PT→EN e
        resposta falada (Jarvis). Config em ~/.nexus/plugins/voice.
      </p>
      <button
        className="settings-btn settings-btn--primary"
        onClick={() => {
          onNavigate();
          openVoice();
        }}
      >
        Abrir configurações de voz
      </button>
    </section>
  );
}

export function ProvidersSection({ adapters }: { adapters: AdapterInfo[] }) {
  return (
    <section>
      <h3 className="settings-detail__title">Providers</h3>
      <p className="settings-detail__hint">
        Adapters de CLI/API detectados ({adapters.length}). Tokens ficam no
        ambiente/Keychain — nunca no banco.
      </p>
      <ul className="settings-list">
        {adapters.map((a) => (
          <li key={a.id} className="settings-list__item">
            <div className="settings-list__head">
              <span className="settings-list__title">
                {a.icon} {a.label}
              </span>
              <span
                className={`settings-chip ${a.installed ? 'settings-chip--ok' : 'settings-chip--warn'}`}
              >
                {a.installed ? 'instalado' : 'ausente'}
              </span>
            </div>
            <p className="settings-list__detail">
              {a.models.list.length} modelo(s) · default {a.models.default}
            </p>
            {!a.installed && (
              <p className="settings-list__detail">
                <code>{a.installCommand}</code>
              </p>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

export function SquadsSection({ onNavigate }: { onNavigate: () => void }) {
  const squads = useOrchStore((s) => s.squads);
  const openPanel = useOrchStore((s) => s.openPanel);
  return (
    <section>
      <h3 className="settings-detail__title">Squads</h3>
      <p className="settings-detail__hint">
        {squads.length} squad(s) salvos — schema compatível com o
        squads.json do Overclock, com export/import nativo.
      </p>
      <ul className="settings-list">
        {squads.map((s) => (
          <li key={s.id} className="settings-list__item">
            <div className="settings-list__head">
              <span className="settings-list__title">{s.name}</span>
              <span className="settings-chip">{s.agents.length} agentes</span>
            </div>
          </li>
        ))}
      </ul>
      <button
        className="settings-btn settings-btn--primary"
        onClick={() => {
          onNavigate();
          openPanel('squads');
        }}
      >
        Gerenciar no painel de orquestração
      </button>
    </section>
  );
}

interface MarketplaceItem {
  name?: string;
  kind?: string;
  description?: string;
}

export function MarketplaceSection() {
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState<'agent' | 'skill' | 'command' | ''>('');
  const [results, setResults] = useState<MarketplaceItem[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function search() {
    if (!query.trim()) return;
    setBusy(true);
    setStatus(null);
    const res = await window.nexus.orch.searchCatalog({
      query: query.trim(),
      kind: kind || undefined,
      limit: 15,
    });
    setBusy(false);
    if (!res.ok) {
      setStatus(res.error ?? 'busca falhou');
      setResults([]);
      return;
    }
    setResults((res.results as MarketplaceItem[]) ?? []);
    setStatus(res.results?.length ? null : 'nenhum resultado');
  }

  async function install(item: MarketplaceItem) {
    if (!item.name) return;
    setBusy(true);
    const res = await window.nexus.orch.installCatalogItem({
      item: item.name,
      kind: (item.kind as 'agent' | 'skill' | 'command') ?? undefined,
    });
    setBusy(false);
    setStatus(
      res.ok ? `instalado em ${res.installedTo}` : res.error ?? 'falhou',
    );
  }

  return (
    <section>
      <h3 className="settings-detail__title">Marketplace</h3>
      <p className="settings-detail__hint">
        Catálogo comunitário aitmpl.com (70+ agentes/skills/commands) —
        instalação em 1 clique para ~/.nexus/plugins/catalog.
      </p>
      <div className="settings-row">
        <input
          className="settings-input"
          value={query}
          placeholder="buscar no catálogo…"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void search()}
        />
        <select
          className="settings-input settings-input--narrow"
          value={kind}
          onChange={(e) =>
            setKind(e.target.value as 'agent' | 'skill' | 'command' | '')
          }
        >
          <option value="">todos</option>
          <option value="agent">agent</option>
          <option value="skill">skill</option>
          <option value="command">command</option>
        </select>
        <button
          className="settings-btn settings-btn--primary"
          onClick={() => void search()}
          disabled={busy || !query.trim()}
        >
          Buscar
        </button>
      </div>
      {status && <p className="settings-detail__hint">{status}</p>}
      <ul className="settings-list">
        {results.map((item, index) => (
          <li key={`${item.name}-${index}`} className="settings-list__item">
            <div className="settings-list__head">
              <span className="settings-list__title">{item.name}</span>
              {item.kind && <span className="settings-chip">{item.kind}</span>}
              <button
                className="settings-btn"
                onClick={() => void install(item)}
                disabled={busy}
              >
                Instalar
              </button>
            </div>
            {item.description && (
              <p className="settings-list__detail">{item.description}</p>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
