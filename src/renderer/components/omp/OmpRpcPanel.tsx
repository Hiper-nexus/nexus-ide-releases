import { useEffect, useId, useRef, useState } from 'react';
import type { OmpRpcSessionLifecycle } from '../../../shared/omp-rpc-types';
import {
  useOmpRpcStore,
  type OmpPendingUiRequest,
  type OmpTranscriptEntry,
} from '../../state/omp-rpc-store';
import { useLayoutStore } from '../../state/layout-store';
import { useToastStore } from '../../state/toast-store';
import { waitForSession } from '../../terminal/terminal-host';

/**
 * Painel da sessão oh-my-pi via RPC nativo (`omp --mode rpc-ui`, sem PTY):
 * transcript com streaming, cards compactos de tool, chip de contexto, seletor
 * de modelo e trilha de aprovações. Denso em sinal, doutrina aviônica —
 * estado sempre visível, neon com parcimônia (PRODUCT.md).
 */

const STATE_LABEL: Record<OmpRpcSessionLifecycle, string> = {
  spawning: 'INICIANDO',
  ready: 'PRONTO',
  busy: 'EXECUTANDO',
  idle: 'OCIOSO',
  exited: 'ENCERRADO',
};

function contextTone(percent: number): 'ok' | 'warn' | 'danger' {
  if (percent >= 0.85) return 'danger';
  if (percent >= 0.6) return 'warn';
  return 'ok';
}

/**
 * Seção "Contas": login OAuth de assinaturas do omp (auth-broker) sem
 * terminal — lista os provedores, sonda conectados e dirige o fluxo
 * (abre o navegador, aguarda o callback, confirma). Funciona SEM sessão
 * ativa; o painel desmonta ao fechar, então a lista recarrega a cada abertura.
 */
function OmpAccountsSection() {
  const authProviders = useOmpRpcStore((s) => s.authProviders);
  const authProvidersLoading = useOmpRpcStore((s) => s.authProvidersLoading);
  const authProvidersError = useOmpRpcStore((s) => s.authProvidersError);
  const loginFlow = useOmpRpcStore((s) => s.loginFlow);
  const models = useOmpRpcStore((s) => s.models);
  const loadAuthProviders = useOmpRpcStore((s) => s.loadAuthProviders);
  const startProviderLogin = useOmpRpcStore((s) => s.startProviderLogin);
  const cancelProviderLogin = useOmpRpcStore((s) => s.cancelProviderLogin);
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    void loadAuthProviders();
  }, [loadAuthProviders]);

  const hasDisconnected = authProviders.some((p) => !p.connected);
  const showHint = models.length <= 1 && hasDisconnected;
  const flowProvider = loginFlow
    ? authProviders.find((p) => p.id === loginFlow.providerId)
    : undefined;

  return (
    <section className="omp-accounts" aria-label="Contas do omp">
      {showHint ? (
        <p className="omp-accounts__hint">
          Conecte uma assinatura abaixo para liberar mais modelos no seletor.
        </p>
      ) : null}
      <button
        type="button"
        className="omp-accounts__header"
        aria-expanded={!collapsed}
        onClick={() => setCollapsed((value) => !value)}
      >
        <span aria-hidden="true">{collapsed ? '▸' : '▾'}</span>
        Contas
        {authProvidersLoading ? (
          <span className="omp-accounts__status">· sondando…</span>
        ) : null}
      </button>
      {collapsed ? null : (
        <div className="omp-accounts__body">
          {loginFlow ? (
            <div className="omp-auth-flow" aria-live="polite">
              <div className="omp-auth-flow__title">
                Autorize no navegador: {flowProvider?.name ?? loginFlow.providerId}
              </div>
              {loginFlow.url ? (
                <>
                  <span className="omp-auth-flow__url" title={loginFlow.url}>
                    {loginFlow.url}
                  </span>
                  <div>
                    <button
                      type="button"
                      className="omp-btn omp-btn--primary"
                      onClick={() => {
                        const url = loginFlow.url;
                        if (!url) return;
                        // openExternal só aceita https (mesma guarda do open-url
                        // do transcript) — a URL vem validada do main.
                        void window.nexus.app.openExternal(url).then((res) => {
                          if (!res.ok) {
                            useToastStore
                              .getState()
                              .push(
                                'error',
                                'Não foi possível abrir a URL',
                                res.error ?? url,
                              );
                          }
                        });
                      }}
                    >
                      Abrir no navegador
                    </button>
                  </div>
                </>
              ) : null}
              <div className="omp-auth-flow__waiting">
                <span className="omp-tool__spinner" aria-hidden="true" />
                aguardando autorização…
                <button
                  type="button"
                  className="omp-btn omp-btn--dim"
                  onClick={() => void cancelProviderLogin()}
                >
                  Cancelar
                </button>
              </div>
            </div>
          ) : null}
          {authProvidersError ? (
            <p className="omp-accounts__error">{authProvidersError}</p>
          ) : null}
          {!authProvidersError && authProviders.length === 0 && !authProvidersLoading ? (
            <p className="omp-accounts__status">Nenhum provedor OAuth encontrado.</p>
          ) : null}
          <ul className="omp-accounts__list">
            {authProviders.map((provider) => (
              <li key={provider.id} className="omp-account">
                <span
                  className={`omp-account__dot omp-account__dot--${
                    provider.connected ? 'on' : 'off'
                  }`}
                  aria-hidden="true"
                />
                <span className="omp-account__name">{provider.name}</span>
                <span className="omp-sr-only">
                  {provider.connected ? 'conectado' : 'não conectado'}
                </span>
                {provider.connected ? (
                  <span className="omp-account__check" aria-hidden="true">
                    ✓
                  </span>
                ) : (
                  <button
                    type="button"
                    className="omp-btn"
                    disabled={loginFlow !== null}
                    onClick={() => void startProviderLogin(provider.id)}
                  >
                    Conectar
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

// Desfecho da tool em texto, para leitores de tela — o glyph ✓/✗/spinner é
// puramente visual (aria-hidden). Cobre running→ok/error.
const TOOL_STATUS_LABEL: Record<'running' | 'ok' | 'error', string> = {
  running: 'em execução',
  ok: 'concluída',
  error: 'falhou',
};

function ToolCard({ entry }: { entry: Extract<OmpTranscriptEntry, { kind: 'tool' }> }) {
  const glyph =
    entry.status === 'ok' ? '✓' : entry.status === 'error' ? '✗' : null;
  const statusLabel = TOOL_STATUS_LABEL[entry.status];
  return (
    // aria-live/atomic: cada card é sua própria região viva, então a transição
    // running→ok/error é anunciada sem varrer o transcript inteiro (evita spam).
    <div
      className={`omp-tool omp-tool--${entry.status}`}
      aria-live="polite"
      aria-atomic="true"
    >
      <span className="omp-tool__status" aria-hidden="true">
        {glyph ?? <span className="omp-tool__spinner" />}
      </span>
      <span className="omp-tool__name">{entry.name}</span>
      {entry.argsPreview ? (
        <span className="omp-tool__args" title={entry.argsPreview}>
          {entry.argsPreview}
        </span>
      ) : null}
      <span className="omp-sr-only">{statusLabel}</span>
    </div>
  );
}

function ApprovalDialog({ request }: { request: OmpPendingUiRequest }) {
  const respondUi = useOmpRpcStore((s) => s.respondUi);
  const [text, setText] = useState('');
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const messageId = useId();

  // Modal real (não só role="alertdialog"): o foco entra ao montar, circula
  // dentro do dialog (Tab/Shift+Tab), Esc escolhe o desfecho seguro e o foco
  // volta ao gatilho ao fechar. Sem libs — só um useEffect com cleanup.
  useEffect(() => {
    const node = dialogRef.current;
    if (!node) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;

    const focusable = () =>
      Array.from(
        node.querySelectorAll<HTMLElement>(
          'button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((el) => el.offsetParent !== null || el === document.activeElement);

    // Foco inicial no primeiro alvo acionável (Permitir/Negar/opção/textarea).
    const initial = focusable();
    (initial[0] ?? node).focus();

    // Esc = opção segura: negar (confirm) ou cancelar (select/input/editor).
    const cancel = () => {
      if (request.method === 'confirm') {
        void respondUi(request.requestId, { confirmed: false });
      } else {
        void respondUi(request.requestId, { cancelled: true });
      }
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        cancel();
        return;
      }
      if (event.key !== 'Tab') return;
      const items = focusable();
      if (items.length === 0) {
        event.preventDefault();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (event.shiftKey) {
        if (active === first || !node.contains(active)) {
          event.preventDefault();
          last.focus();
        }
      } else if (active === last || !node.contains(active)) {
        event.preventDefault();
        first.focus();
      }
    };

    node.addEventListener('keydown', onKeyDown);
    return () => {
      node.removeEventListener('keydown', onKeyDown);
      // Foco retorna ao elemento anterior ao dialog ao fechar.
      previouslyFocused?.focus?.();
    };
    // requestId/method/respondUi são estáveis por instância → roda uma vez.
  }, [request.requestId, request.method, respondUi]);

  return (
    <div
      className="omp-approval"
      role="alertdialog"
      aria-modal="true"
      aria-label={request.title}
      aria-describedby={request.message ? messageId : undefined}
      ref={dialogRef}
      tabIndex={-1}
    >
      <div className="omp-approval__title">{request.title}</div>
      {request.message ? (
        <div className="omp-approval__message" id={messageId}>
          {request.message}
        </div>
      ) : null}
      {request.method === 'confirm' ? (
        <div className="omp-approval__actions">
          <button
            type="button"
            className="omp-btn omp-btn--primary"
            onClick={() => void respondUi(request.requestId, { confirmed: true })}
          >
            Permitir
          </button>
          <button
            type="button"
            className="omp-btn"
            onClick={() => void respondUi(request.requestId, { confirmed: false })}
          >
            Negar
          </button>
        </div>
      ) : null}
      {request.method === 'select' ? (
        <div className="omp-approval__actions omp-approval__actions--stack">
          {(request.options ?? []).map((option) => (
            <button
              key={option}
              type="button"
              className="omp-btn"
              onClick={() => void respondUi(request.requestId, { value: option })}
            >
              {option}
            </button>
          ))}
          <button
            type="button"
            className="omp-btn omp-btn--dim"
            onClick={() => void respondUi(request.requestId, { cancelled: true })}
          >
            Cancelar
          </button>
        </div>
      ) : null}
      {request.method === 'input' || request.method === 'editor' ? (
        <div className="omp-approval__actions omp-approval__actions--stack">
          <textarea
            className="omp-approval__input"
            rows={request.method === 'editor' ? 4 : 1}
            placeholder={request.placeholder ?? ''}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <div className="omp-approval__actions">
            <button
              type="button"
              className="omp-btn omp-btn--primary"
              onClick={() => void respondUi(request.requestId, { value: text })}
            >
              Enviar
            </button>
            <button
              type="button"
              className="omp-btn"
              onClick={() => void respondUi(request.requestId, { cancelled: true })}
            >
              Cancelar
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function OmpRpcPanel() {
  const open = useOmpRpcStore((s) => s.panelOpen);
  const toggle = useOmpRpcStore((s) => s.togglePanel);
  const sessionId = useOmpRpcStore((s) => s.sessionId);
  const starting = useOmpRpcStore((s) => s.starting);
  const startError = useOmpRpcStore((s) => s.startError);
  const snapshot = useOmpRpcStore((s) => s.snapshot);
  const approvalPolicy = useOmpRpcStore((s) => s.approvalPolicy);
  const setApprovalPolicy = useOmpRpcStore((s) => s.setApprovalPolicy);
  const transcript = useOmpRpcStore((s) => s.transcript);
  const models = useOmpRpcStore((s) => s.models);
  const pendingUi = useOmpRpcStore((s) => s.pendingUi);
  const start = useOmpRpcStore((s) => s.start);
  const sendPrompt = useOmpRpcStore((s) => s.sendPrompt);
  const abort = useOmpRpcStore((s) => s.abort);
  const setModel = useOmpRpcStore((s) => s.setModel);
  const disposeSession = useOmpRpcStore((s) => s.disposeSession);

  const [draft, setDraft] = useState('');
  const bodyRef = useRef<HTMLDivElement | null>(null);

  // Autoscroll: acompanha o streaming sem roubar a rolagem do usuário.
  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (nearBottom) el.scrollTop = el.scrollHeight;
  }, [transcript]);

  // Auto-start on open (product default): one click to see omp work.
  // Honors orch.ompRpcAutoStart; skips when a startError is already showing.
  // Intentionally omit `start` from deps — zustand action identity is stable
  // and including it re-triggers after every start() completion path.
  useEffect(() => {
    if (!open || sessionId || starting || startError) return;
    let cancelled = false;
    void (async () => {
      try {
        const orch = await window.nexus.settings.orchGet();
        if (cancelled || orch.ompRpcAutoStart === false) return;
        await start();
      } catch {
        // Manual "Iniciar sessão" remains available.
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- start is stable
  }, [open, sessionId, starting, startError]);

  if (!open) return null;

  const state = snapshot?.state ?? (starting ? 'spawning' : null);
  const streaming = snapshot?.isStreaming === true || state === 'busy';
  const usage = snapshot?.contextUsage ?? null;
  const modelValue = snapshot?.model
    ? `${snapshot.model.provider}/${snapshot.model.id}`
    : '';

  const submit = (behavior?: 'steer' | 'followUp') => {
    const message = draft.trim();
    if (!message) return;
    setDraft('');
    void sendPrompt(message, behavior);
  };

  return (
    <aside className="omp-panel" aria-label="Sessão oh-my-pi (RPC)">
      <header className="omp-panel__header">
        <span className="omp-panel__mark" aria-hidden="true">π</span>
        <span className="omp-panel__title">OMP · RPC</span>
        {state ? (
          <span className={`omp-state omp-state--${state}`}>
            <span className="omp-state__dot" aria-hidden="true" />
            {STATE_LABEL[state]}
          </span>
        ) : null}
        <span className="omp-panel__spacer" />
        {approvalPolicy === 'yolo' ? (
          <span
            className="omp-badge omp-badge--auto"
            title="Aprovações automáticas auditadas"
          >
            AUTO
            {snapshot && snapshot.autoApprovals > 0
              ? ` ×${snapshot.autoApprovals}`
              : ''}
          </span>
        ) : (
          <span className="omp-badge" title="Aprovações pedem confirmação">
            SAFE
          </span>
        )}
        <button
          type="button"
          className="omp-panel__close"
          aria-label="Fechar painel OMP"
          onClick={toggle}
        >
          ✕
        </button>
      </header>

      <div className="omp-panel__controls">
        {sessionId ? (
          <>
            <select
              className="omp-select"
              aria-label="Modelo"
              value={modelValue}
              onChange={(e) => {
                const [provider, ...rest] = e.target.value.split('/');
                if (provider && rest.length > 0) {
                  void setModel(provider, rest.join('/'));
                }
              }}
            >
              {modelValue && !models.some((m) => `${m.provider}/${m.id}` === modelValue) ? (
                <option value={modelValue}>{modelValue}</option>
              ) : null}
              {models.map((model) => (
                <option
                  key={`${model.provider}/${model.id}`}
                  value={`${model.provider}/${model.id}`}
                >
                  {model.provider}/{model.id}
                </option>
              ))}
            </select>
            {usage ? (
              <span
                className={`omp-context omp-context--${contextTone(usage.percent)}`}
                title={`${usage.tokens.toLocaleString()} / ${usage.contextWindow.toLocaleString()} tokens`}
              >
                CTX {Math.round(usage.percent * 100)}%
              </span>
            ) : null}
            <button
              type="button"
              className="omp-btn omp-btn--dim"
              onClick={() => void disposeSession()}
            >
              Encerrar
            </button>
          </>
        ) : (
          <>
            <label className="omp-policy">
              <span>Aprovações</span>
              <select
                className="omp-select"
                value={approvalPolicy}
                onChange={(e) =>
                  setApprovalPolicy(e.target.value === 'yolo' ? 'yolo' : 'safe')
                }
              >
                <option value="safe">safe — pedir confirmação</option>
                <option value="yolo">yolo — auto (auditado)</option>
              </select>
            </label>
            <button
              type="button"
              className="omp-btn omp-btn--primary"
              disabled={starting}
              onClick={() => void start()}
            >
              {starting ? 'Iniciando…' : 'Iniciar sessão'}
            </button>
          </>
        )}
      </div>

      {startError ? (
        <div className="omp-panel__error">
          {startError}
          {/sem login\/modelo/i.test(startError) && (
            <button
              type="button"
              className="settings-btn settings-btn--primary omp-panel__install"
              onClick={() => {
                const paneId = useLayoutStore.getState().addShellPane();
                void waitForSession(paneId).then((sessionId) => {
                  if (sessionId) window.nexus.pty.write(sessionId, 'omp\r');
                });
              }}
              title="Abre um terminal com o omp — rode /login lá e volte para Iniciar sessão"
            >
              Abrir omp no terminal (/login)
            </button>
          )}
          {/não encontrado no PATH/i.test(startError) && (
            <button
              type="button"
              className="settings-btn settings-btn--primary omp-panel__install"
              onClick={() => {
                void window.nexus.providers.installCli('omp').then((r) => {
                  if (r.ok) void start();
                });
              }}
              title="Instala o omp pela fonte oficial (confirmação nativa mostra o comando exato)"
            >
              Instalar omp automaticamente
            </button>
          )}
        </div>
      ) : null}

      <OmpAccountsSection />

      <div className="omp-panel__body" ref={bodyRef}>
        {transcript.length === 0 ? (
          <p className="omp-panel__empty">
            Sessão nativa do oh-my-pi por NDJSON — sem PTY, sem scraping.
            Inicie e mande o primeiro prompt.
          </p>
        ) : null}
        {transcript.map((entry) => {
          switch (entry.kind) {
            case 'user':
              return (
                <div key={entry.id} className="omp-line omp-line--user">
                  {entry.text}
                </div>
              );
            case 'assistant':
              return (
                <div key={entry.id} className="omp-line omp-line--assistant">
                  {entry.text}
                  {entry.open ? <span className="omp-caret" aria-hidden="true" /> : null}
                </div>
              );
            case 'thinking':
              return (
                <div key={entry.id} className="omp-line omp-line--thinking">
                  {entry.text}
                </div>
              );
            case 'tool':
              return <ToolCard key={entry.id} entry={entry} />;
            case 'notice':
              return (
                <div
                  key={entry.id}
                  className={`omp-line omp-line--notice omp-line--${entry.level}`}
                >
                  {entry.text}
                </div>
              );
            case 'open-url':
              // URL exibida por inteiro (o usuário vê para ONDE vai antes de
              // clicar); a abertura passa pelo openExternal https-only do main.
              return (
                <div key={entry.id} className="omp-line omp-line--notice omp-line--info">
                  <span className="omp-open-url__label">
                    O omp pediu para abrir: {entry.url}
                  </span>{' '}
                  <button
                    type="button"
                    className="omp-btn omp-btn--primary"
                    onClick={() => {
                      // openExternal só aceita https; um flow de login que
                      // pedir http/localhost falharia em silêncio sem isto.
                      void window.nexus.app.openExternal(entry.url).then((res) => {
                        if (!res.ok) {
                          useToastStore.getState().push(
                            'error',
                            'Não foi possível abrir a URL',
                            res.error ?? entry.url,
                          );
                        }
                      });
                    }}
                  >
                    Abrir no navegador
                  </button>
                </div>
              );
            default:
              return null;
          }
        })}
        {pendingUi.map((request) => (
          <ApprovalDialog key={request.requestId} request={request} />
        ))}
      </div>

      <footer className="omp-panel__composer">
        <textarea
          className="omp-composer__input"
          rows={2}
          placeholder={
            streaming
              ? 'Agente executando — Enter enfileira (follow-up)…'
              : 'Prompt para o omp… (Enter envia)'
          }
          value={draft}
          disabled={!sessionId}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              submit(streaming ? 'followUp' : undefined);
            }
          }}
        />
        {streaming ? (
          <div className="omp-composer__row">
            <button
              type="button"
              className="omp-btn"
              onClick={() => submit('steer')}
              disabled={!draft.trim()}
            >
              Steer
            </button>
            <button
              type="button"
              className="omp-btn"
              onClick={() => submit('followUp')}
              disabled={!draft.trim()}
            >
              Follow-up
            </button>
            <button
              type="button"
              className="omp-btn omp-btn--dim"
              onClick={() => void abort()}
            >
              Abortar
            </button>
          </div>
        ) : null}
      </footer>
    </aside>
  );
}
