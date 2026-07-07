import { useEffect, useState } from 'react';
import { useSettingsStore } from '../../state/settings-store';
import { useOrchStore } from '../../state/orch-store';
import { useVoiceStore } from '../../voice/voice-store';
import { CURRENT_RELEASE } from '../../../shared/release-notes';
import { UpdateReadinessPanel } from './ObservabilitySections';

/** MÓDULOS sections: Terminal, Voice, Providers, Squads, Marketplace. */

export function TerminalSection() {
  const terminal = useSettingsStore((s) => s.terminal);
  const update = useSettingsStore((s) => s.update);

  return (
    <section>
      <h3 className="settings-detail__title">Terminal</h3>
      <p className="settings-detail__hint">
        Fonte e shell dos panes xterm. Paleta e modo pixel ficam em Aparência.
      </p>

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

export function SystemSection() {
  const release = CURRENT_RELEASE;
  return (
    <section>
      <div className="release-head">
        <div>
          <h3 className="settings-detail__title">Sistema</h3>
          <p className="settings-detail__hint">
            Versão atual, changelog e estado do pacote local instalado.
          </p>
        </div>
        <span className="release-version">v{release.version}</span>
      </div>

      <div className="release-summary">
        <div>
          <span className="settings-chip settings-chip--ok">instalada</span>
          <span className="settings-chip">{release.date}</span>
          <span className="settings-chip">{release.codename}</span>
        </div>
        <p>{release.summary}</p>
      </div>

      <h4 className="release-section-title">Changelog · melhorias</h4>
      <ul className="settings-list">
        {release.highlights.map((item) => (
          <li key={item.title} className="settings-list__item release-note">
            <div className="settings-list__head">
              <span className="settings-list__title">{item.title}</span>
            </div>
            <p className="settings-list__detail">{item.detail}</p>
          </li>
        ))}
      </ul>

      <h4 className="release-section-title">Changelog · correções</h4>
      <ul className="settings-list">
        {release.fixes.map((item) => (
          <li key={item.title} className="settings-list__item release-note">
            <div className="settings-list__head">
              <span className="settings-list__title">{item.title}</span>
            </div>
            <p className="settings-list__detail">{item.detail}</p>
          </li>
        ))}
      </ul>

      <UpdateReadinessPanel />
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
        {[...squads]
          .sort((a, b) => Number(a.builtin ?? false) - Number(b.builtin ?? false))
          .map((s) => (
            <li key={s.id} className="settings-list__item">
              <div className="settings-list__head">
                <span className="settings-list__title">{s.name}</span>
                <span className="settings-chip">
                  {s.builtin ? 'original' : 'seu'}
                </span>
                <span className="settings-chip">{s.agents.length} agentes</span>
                <div className="settings-list__spacer" />
                {!s.builtin && (
                  <button
                    className="settings-btn settings-btn--danger"
                    title="Apagar este squad (não pode desfazer)"
                    onClick={() => {
                      if (
                        window.confirm(`Apagar o squad "${s.name}"? Não dá para desfazer.`)
                      ) {
                        void window.nexus.orch.deleteSquad(s.id);
                      }
                    }}
                  >
                    Apagar
                  </button>
                )}
              </div>
            </li>
          ))}
      </ul>
      <p className="settings-field__note">
        Squads que você cria (manuais ou &quot;sob medida&quot;) ficam salvos
        para sempre. Os originais voltam sozinhos a cada início.
      </p>
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
