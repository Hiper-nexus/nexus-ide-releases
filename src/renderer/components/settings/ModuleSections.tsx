import { useEffect, useState } from 'react';
import { useSettingsStore } from '../../state/settings-store';
import { askConfirm } from '../../state/confirm-store';
import { useOrchStore } from '../../state/orch-store';
import { useVoiceStore } from '../../voice/voice-store';
import { CURRENT_RELEASE } from '../../../shared/release-notes';
import { UpdateReadinessPanel } from './ObservabilitySections';
import { AudioDeviceControls } from './AudioDeviceControls';
import { OrchestratorDefaults } from './OrchestratorDefaults';

/** MÓDULOS sections: Terminal, Voice, Providers, Squads, Marketplace. */

function OrchestrationToggle({
  checked,
  title,
  detail,
  onChange,
}: {
  checked: boolean;
  title: string;
  detail: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="settings-toggle-row">
      <span className="settings-toggle-row__copy">
        <strong>{title}</strong>
        <span>{detail}</span>
      </span>
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className="settings-toggle-row__control" aria-hidden="true" />
    </label>
  );
}

export function TerminalSection() {
  const terminal = useSettingsStore((s) => s.terminal);
  const update = useSettingsStore((s) => s.update);
  const [shells, setShells] = useState<string[]>([]);

  useEffect(() => {
    let cancelled = false;
    void window.nexus.settings.listShells().then((detected) => {
      if (!cancelled) setShells(detected);
    });
    return () => {
      cancelled = true;
    };
  }, []);

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
        Shell padrão
        <select
          className="settings-input"
          value={terminal.shell}
          onChange={(e) => void update({ shell: e.target.value })}
        >
          <option value="">
            Padrão do sistema{shells[0] ? ` — ${shells[0].split('/').pop()}` : ''}
          </option>
          {terminal.shell && !shells.includes(terminal.shell) && (
            <option value={terminal.shell}>{terminal.shell} (não detectado)</option>
          )}
          {shells.map((shell) => (
            <option key={shell} value={shell}>
              {shell}
            </option>
          ))}
        </select>
        <span className="settings-field__note">
          {shells.length} shell(s) detectado(s). Vale para novos panes; os já
          abertos continuam no shell atual.
        </span>
      </label>

      <details className="settings-advanced-field">
        <summary>Usar outro caminho absoluto</summary>
        <input
          className="settings-input"
          value={terminal.shell}
          placeholder="/caminho/para/seu/shell"
          onChange={(e) => void update({ shell: e.target.value })}
        />
      </details>
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
      <AudioDeviceControls />
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
        Defina como os especialistas trabalham e abra o painel para criar,
        importar ou editar seus {squads.length} squads salvos.
      </p>

      <OrchestratorDefaults />

      <h4 className="settings-section-heading">Padrões de execução</h4>
      <div className="settings-toggle-list">
        <OrchestrationToggle
          checked={seniorMode}
          title="Disciplina sênior"
          detail="Exige stack correta, testes e lint verdes, revisão de segurança e documentação viva."
          onChange={(checked) => {
            setSeniorMode(checked);
            void window.nexus.settings.orchSet({ seniorMode: checked });
          }}
        />
        <OrchestrationToggle
          checked={designPro}
          title="Design profissional"
          detail="Aplica o design system do projeto, estados completos e revisão Impeccable em tarefas de UI."
          onChange={(checked) => {
            setDesignPro(checked);
            void window.nexus.settings.orchSet({ designPro: checked });
          }}
        />
        <OrchestrationToggle
          checked={leanCode}
          title="Código enxuto"
          detail="Prioriza reuso e a menor implementação segura, sem abstrações ou dependências desnecessárias."
          onChange={(checked) => {
            setLeanCode(checked);
            void window.nexus.settings.orchSet({ leanCode: checked });
          }}
        />
      </div>
      <div className="settings-section-heading settings-section-heading--with-count">
        <h4>Squads disponíveis</h4>
        <span className="settings-chip">{squads.length}</span>
      </div>
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
                      void askConfirm({
                        title: `Apagar o squad "${s.name}"?`,
                        body: 'Não dá para desfazer.',
                        confirmLabel: 'Apagar squad',
                        danger: true,
                      }).then((ok) => {
                        if (ok) void window.nexus.orch.deleteSquad(s.id);
                      });
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
