import { useEffect, useMemo, useState } from 'react';
import type { AdapterInfo } from '../../shared/types';
import { VICTORY_KEYS, type VictoryKey } from '../../shared/onboarding-types';
import { useOnboardingStore } from '../state/onboarding-store';
import { NexusMark } from './NexusMark';
import { ProviderLogo } from './ProviderLogo';

/**
 * Onboarding de primeira execução — a tela que PREPARA o sistema, no lugar de
 * jogar o usuário direto no deck. Responde "o que eu preciso para começar?":
 * mostra as CLIs de IA detectadas (e o comando para instalar as que faltam),
 * o estado da voz, e um checklist de vitórias que ensina o fluxo. Aparece só
 * quando o onboarding nunca foi concluído nem pulado.
 *
 * Não é modal-bloqueante por capricho: é a preparação inicial, com "pular"
 * sempre à mão (Esc), e nunca reaparece depois de concluído.
 */

const VICTORY_LABELS: Record<VictoryKey, string> = {
  cliDetected: 'Uma CLI de IA detectada',
  firstMission: 'Primeira missão iniciada',
  firstHandoff: 'Primeiro handoff recebido',
  voiceEnabled: 'Voz (Jarvis) ativada',
  catalogInstalled: 'Um agente do catálogo instalado',
};

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="onb__copy"
      title="Copiar comando"
      aria-label={
        copied ? 'Comando copiado' : 'Copiar comando de instalação'
      }
      data-copied={copied ? 'true' : undefined}
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1400);
        });
      }}
    >
      {copied ? 'Copiado' : 'Copiar'}
    </button>
  );
}

export function Onboarding() {
  const state = useOnboardingStore((s) => s.state);
  const loaded = useOnboardingStore((s) => s.loaded);
  const complete = useOnboardingStore((s) => s.complete);
  const skip = useOnboardingStore((s) => s.skip);
  const markVictory = useOnboardingStore((s) => s.markVictory);

  const [adapters, setAdapters] = useState<AdapterInfo[]>([]);
  const visible = loaded && !state.completed && !state.skipped;

  // Auto-install: a 1ª CLI ausente com instalador automático vira o CTA
  // primário — nunca um botão disabled como primeiro frame (critique P2).
  const [autoInstallable, setAutoInstallable] = useState<{
    adapterId: string;
    label: string;
  } | null>(null);
  const [installing, setInstalling] = useState(false);
  const [installError, setInstallError] = useState<string | null>(null);
  /** Label da CLI instalada com sucesso nesta sessão de onboarding. */
  const [installDone, setInstallDone] = useState<string | null>(null);

  useEffect(() => {
    if (!visible) return;
    void window.nexus.adapters.list().then(setAdapters);
    const unsub = window.nexus.adapters.onChanged(setAdapters);
    return unsub;
  }, [visible]);

  // Detectar ao menos uma CLI é a primeira vitória — registra sozinha.
  const installed = useMemo(
    () => adapters.filter((a) => a.kind === 'cli-pty' && a.installed),
    [adapters],
  );
  const missing = useMemo(
    () => adapters.filter((a) => a.kind === 'cli-pty' && !a.installed),
    [adapters],
  );
  useEffect(() => {
    if (installed.length > 0) markVictory('cliDetected');
  }, [installed.length, markVictory]);

  // Sem CLI detectada: descobre se alguma tem instalador automático — o CTA
  // primário passa a ser "Instalar …" (ação) em vez de um disabled parado.
  useEffect(() => {
    if (!visible || installed.length > 0) return;
    let cancelled = false;
    void window.nexus.providers
      .list()
      .then((list) => {
        if (cancelled) return;
        const candidate = list.find((p) => !p.installed && p.canAutoInstall);
        setAutoInstallable(
          candidate
            ? { adapterId: candidate.adapterId, label: candidate.label }
            : null,
        );
      })
      .catch(() => {
        if (!cancelled) setAutoInstallable(null);
      });
    return () => {
      cancelled = true;
    };
  }, [visible, installed.length]);

  async function handleAutoInstall() {
    if (!autoInstallable || installing) return;
    setInstalling(true);
    setInstallError(null);
    try {
      const result = await window.nexus.providers.installCli(
        autoInstallable.adapterId,
      );
      if (result.ok) {
        // O cache de adapters do main só re-escaneia a cada ~5min, então NÃO
        // dá para esperar adapters.onChanged confirmar a instalação: marca
        // o sucesso otimista e o CTA vira "Começar a operar" já.
        setInstallDone(autoInstallable.label);
        setAutoInstallable(null);
      } else {
        setInstallError(result.error ?? 'instalação falhou');
      }
    } catch (err) {
      setInstallError(
        err instanceof Error ? err.message : 'instalação falhou',
      );
    } finally {
      setInstalling(false);
    }
  }

  /** Abre o bloco "Instalar mais CLIs" quando não há instalador automático. */
  function expandInstallHelp() {
    const details = document.querySelector<HTMLDetailsElement>('.onb__missing');
    if (details && !details.open) details.open = true;
    details?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  useEffect(() => {
    if (!visible) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') skip();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [visible, skip]);

  if (!visible) return null;

  const doneCount = VICTORY_KEYS.filter(
    (k) => state.victories[k] !== undefined,
  ).length;

  return (
    <div className="onb" role="dialog" aria-modal="true" aria-label="Boas-vindas ao NexusIDE">
      <div className="onb__panel">
        <header className="onb__head">
          <NexusMark size={28} className="onb__logo" />
          <div>
            <h1 className="onb__title">Bem-vindo ao NexusIDE</h1>
            <p className="onb__sub">
              Seu centro de comando para orquestrar uma frota de agentes de IA.
              Vamos preparar o essencial.
            </p>
          </div>
          <button className="onb__skip-x" onClick={skip} aria-label="Pular introdução" title="Pular (Esc)">
            <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
              <path d="M3 3 L11 11 M11 3 L3 11" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          </button>
        </header>

        <section className="onb__section" aria-label="CLIs de IA">
          <h2 className="onb__section-title">
            CLIs de IA
            <span className={`onb__pill ${installed.length > 0 ? 'onb__pill--ok' : 'onb__pill--warn'}`}>
              {installed.length > 0 ? `${installed.length} detectada${installed.length === 1 ? '' : 's'}` : 'nenhuma ainda'}
            </span>
          </h2>
          {installed.length > 0 && (
            <ul className="onb__cli-row">
              {installed.map((a) => (
                <li key={a.id} className="onb__cli onb__cli--ok" title={`${a.label} instalada`}>
                  <ProviderLogo adapterId={a.id} label={a.label} fallback={a.icon} size="sm" />
                  {a.label}
                </li>
              ))}
            </ul>
          )}
          {missing.length > 0 && (
            <details className="onb__missing">
              <summary>Instalar mais CLIs ({missing.length} disponíveis)</summary>
              <ul className="onb__install-list">
                {missing.map((a) => (
                  <li key={a.id} className="onb__install">
                    <ProviderLogo adapterId={a.id} label={a.label} fallback={a.icon} size="sm" />
                    <span className="onb__install-label">{a.label}</span>
                    <code className="onb__install-cmd">{a.installCommand}</code>
                    <CopyButton text={a.installCommand} />
                  </li>
                ))}
              </ul>
              <p className="onb__hint">
                Rode o comando num terminal, depois faça login com a própria CLI
                (ex.: <code>claude</code> abre o OAuth no navegador). As
                credenciais ficam no Keychain do macOS, nunca em texto puro.
              </p>
            </details>
          )}
        </section>

        <section className="onb__section" aria-label="Progresso">
          <h2 className="onb__section-title">
            Primeiros passos
            <span className="onb__pill">{doneCount}/{VICTORY_KEYS.length}</span>
          </h2>
          <ul className="onb__victories">
            {VICTORY_KEYS.map((k) => {
              const done = state.victories[k] !== undefined;
              return (
                <li key={k} className={`onb__victory ${done ? 'onb__victory--done' : ''}`}>
                  <span className="onb__check" aria-hidden="true">
                    {done ? '✓' : ''}
                  </span>
                  {VICTORY_LABELS[k]}
                </li>
              );
            })}
          </ul>
        </section>

        <footer className="onb__foot">
          <button className="onb__skip" onClick={skip}>
            Pular
          </button>
          {installed.length > 0 || installDone ? (
            <button
              className="onb__cta"
              onClick={complete}
              title="Ir para o deck"
            >
              Começar a operar ▸
            </button>
          ) : autoInstallable ? (
            <button
              className="onb__cta"
              onClick={() => void handleAutoInstall()}
              disabled={installing}
              title="Instala pela fonte oficial — uma confirmação mostra o comando exato antes"
            >
              {installing ? 'Instalando…' : `Instalar ${autoInstallable.label}`}
            </button>
          ) : missing.length > 0 ? (
            <button
              className="onb__cta"
              onClick={expandInstallHelp}
              title="Ver os comandos de instalação de cada CLI"
            >
              Ver como instalar
            </button>
          ) : null}
        </footer>
        {installDone && installed.length === 0 && (
          <p className="onb__install-done" role="status">
            ✓ {installDone} instalada — o login acontece no primeiro uso.
          </p>
        )}
        {installError && (
          <p className="onb__install-error" role="alert">
            ⚠ {installError} — tente pelo comando em “Instalar mais CLIs”.
          </p>
        )}
      </div>
    </div>
  );
}
