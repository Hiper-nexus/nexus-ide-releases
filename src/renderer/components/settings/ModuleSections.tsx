import { useEffect, useState } from 'react';
import {
  TERMINAL_THEME_IDS,
  type TerminalThemeId,
} from '../../../shared/settings-types';
import { TERMINAL_THEMES } from '../../styles/terminal-theme';
import { useSettingsStore } from '../../state/settings-store';
import { useOrchStore } from '../../state/orch-store';
import { useVoiceStore } from '../../voice/voice-store';

/** MÓDULOS sections: Terminal, Voice, Providers, Squads, Marketplace. */

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

export function VoiceSection({ onNavigate }: { onNavigate: () => void }) {
  const openVoice = useVoiceStore((s) => s.openSettings);
  return (
    <section>
      <h3 className="settings-detail__title">Voice</h3>
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

export function SquadsSection({ onNavigate }: { onNavigate: () => void }) {
  const squads = useOrchStore((s) => s.squads);
  const openPanel = useOrchStore((s) => s.openPanel);
  const [leanCode, setLeanCode] = useState(true);
  const [seniorMode, setSeniorMode] = useState(true);
  const [designPro, setDesignPro] = useState(true);
  useEffect(() => {
    void window.nexus.settings.orchGet().then((o) => {
      setLeanCode(o.leanCode);
      setSeniorMode(o.seniorMode);
      setDesignPro(o.designPro);
    });
  }, []);
  return (
    <section>
      <h3 className="settings-detail__title">Squads</h3>
      <p className="settings-detail__hint">
        {squads.length} squad(s) salvos — schema compatível com o
        squads.json, com export/import nativo.
      </p>

      <label className="settings-field">
        <span>
          <input
            type="checkbox"
            checked={seniorMode}
            onChange={(e) => {
              setSeniorMode(e.target.checked);
              void window.nexus.settings.orchSet({ seniorMode: e.target.checked });
            }}
          />{' '}
          Disciplina sênior (XP)
        </span>
        <span className="settings-field__note">
          Carta de Engenharia em todo worker: stack certa para o projeto (Go,
          Ruby, Rust… não só Node/React), handoff só VERDE (testes/lint do
          projeto), segurança como hábito, refactoring contínuo e spec viva
          (CLAUDE.md/AGENTS.md evolui a cada missão).
        </span>
      </label>

      <label className="settings-field">
        <span>
          <input
            type="checkbox"
            checked={designPro}
            onChange={(e) => {
              setDesignPro(e.target.checked);
              void window.nexus.settings.orchSet({ designPro: e.target.checked });
            }}
          />{' '}
          Design anti-genérico (Impeccable)
        </span>
        <span className="settings-field__note">
          Carta de Design em tarefas com UI: bane a &quot;cara de IA&quot;
          (✨ sparkles, gradiente roxo, glassmorphism, grids idênticos),
          exige design system do projeto, estados completos e roda
          impeccable detect quando disponível.
        </span>
      </label>

      <label className="settings-field">
        <span>
          <input
            type="checkbox"
            checked={leanCode}
            onChange={(e) => {
              setLeanCode(e.target.checked);
              void window.nexus.settings.orchSet({ leanCode: e.target.checked });
            }}
          />{' '}
          Código enxuto (ponytail)
        </span>
        <span className="settings-field__note">
          Injeta em todo worker as regras &quot;lazy senior dev&quot; do
          ponytail (MIT): mínimo código que funciona, reuso antes de escrever,
          sem over-engineering. −54% de código e −20% de custo medidos pelo
          autor.
        </span>
      </label>
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

export { MarketplaceSection } from './MarketplaceSection';
