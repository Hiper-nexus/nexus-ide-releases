import { useCallback, useEffect, useRef, useState } from 'react';
import { FEATURE_FLAG_IDS } from '../../../shared/feature-flags';
import type {
  CompanionRelayStartRequest,
  CompanionRelayTransportInfo,
} from '../../../shared/companion-relay-types';
import { useProductFlags } from '../../lib/use-product-flags';
import { QrCode } from '../QrCode';

/**
 * Companion mobile relay (transporte E2E via relay cego). A sala é selada com
 * AES-256-GCM; a chave vive apenas no fragmento do link — por isso o link full
 * dá CONTROLE e o link view só OBSERVA. Nunca logamos link/chave/token.
 *
 * A UI respeita `feature.remote.relayTransport` (default OFF): desligada, mostra
 * como ativar; ligada, expõe start/stop, QR e links com aviso de segurança.
 */

/** Ponte tipada até `window.nexus.remote.relay.*` (costurada no preload). */
interface CompanionRelayBridge {
  status(): Promise<CompanionRelayTransportInfo>;
  start(req: CompanionRelayStartRequest): Promise<CompanionRelayTransportInfo>;
  stop(): Promise<CompanionRelayTransportInfo>;
}

/**
 * Acessa o bridge de forma forward-compatible: quando o wiring do preload
 * ainda não estiver presente (testes/preload degradado), devolve null e a UI
 * mostra um estado de indisponibilidade em vez de quebrar.
 */
function relayBridge(): CompanionRelayBridge | null {
  const nexus = (
    window as unknown as {
      nexus?: { remote?: { relay?: CompanionRelayBridge } };
    }
  ).nexus;
  return nexus?.remote?.relay ?? null;
}

function connectionChip(info: CompanionRelayTransportInfo | null): {
  label: string;
  tone: 'ok' | 'warn' | 'danger';
} {
  if (!info?.running) return { label: 'desligado', tone: 'warn' };
  if (info.lastError) return { label: 'erro de socket', tone: 'danger' };
  if (info.connected) return { label: 'conectado ao relay', tone: 'ok' };
  return { label: 'conectando…', tone: 'warn' };
}

function LinkRow({
  title,
  hint,
  link,
  tone,
}: {
  title: string;
  hint: string;
  link: string;
  tone: 'danger' | 'ok';
}) {
  const [copied, setCopied] = useState(false);
  const copy = useCallback(() => {
    void navigator.clipboard.writeText(link).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    });
  }, [link]);

  return (
    <li className="settings-list__item">
      <div className="settings-list__head">
        <span className="settings-list__title">{title}</span>
        <span className={`settings-chip ${tone === 'danger' ? 'settings-chip--danger' : 'settings-chip--ok'}`}>
          {tone === 'danger' ? 'controle' : 'somente leitura'}
        </span>
      </div>
      <p className="settings-list__detail">{hint}</p>
      <div className="settings-row" style={{ marginBottom: 8 }}>
        <input
          className="settings-input"
          readOnly
          value={link}
          aria-label={`${title} (link de pareamento)`}
          onFocus={(e) => e.currentTarget.select()}
          style={{ flex: 1 }}
        />
        <button
          type="button"
          className="settings-btn settings-btn--sm"
          onClick={copy}
          aria-label={`Copiar ${title}`}
        >
          {copied ? 'copiado' : 'copiar'}
        </button>
      </div>
    </li>
  );
}

export function CompanionRelaySection() {
  const flags = useProductFlags();
  const flagOn = flags[FEATURE_FLAG_IDS.remoteRelayTransport] === true;

  const [info, setInfo] = useState<CompanionRelayTransportInfo | null>(null);
  const [relayUrl, setRelayUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [uiError, setUiError] = useState<string | null>(null);
  const [bridgeMissing, setBridgeMissing] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const refresh = useCallback(async () => {
    const bridge = relayBridge();
    if (!bridge) {
      setBridgeMissing(true);
      return;
    }
    setBridgeMissing(false);
    try {
      setInfo(await bridge.status());
    } catch (err) {
      setUiError(err instanceof Error ? err.message : 'falha ao ler estado');
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Enquanto o relay roda, o guestCount muda com pareamentos — poll calmo (4s),
  // sem animação, além de refresh manual e após cada ação.
  const running = info?.running === true;
  useEffect(() => {
    if (!running) {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
      return;
    }
    pollRef.current = setInterval(() => {
      void refresh();
    }, 4000);
    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [running, refresh]);

  const start = useCallback(async () => {
    const bridge = relayBridge();
    const url = relayUrl.trim();
    if (!bridge || url.length === 0) return;
    setBusy(true);
    setUiError(null);
    try {
      const next = await bridge.start({ relayUrl: url });
      setInfo(next);
      if (next.error) setUiError(next.error);
    } catch (err) {
      setUiError(err instanceof Error ? err.message : 'falha ao iniciar');
    } finally {
      setBusy(false);
    }
  }, [relayUrl]);

  const stop = useCallback(async () => {
    const bridge = relayBridge();
    if (!bridge) return;
    setBusy(true);
    setUiError(null);
    try {
      const next = await bridge.stop();
      setInfo(next);
      if (next.error) setUiError(next.error);
    } catch (err) {
      setUiError(err instanceof Error ? err.message : 'falha ao parar');
    } finally {
      setBusy(false);
    }
  }, []);

  const chip = connectionChip(info);

  return (
    <section>
      <h3 className="settings-detail__title">Companion mobile (relay E2E)</h3>
      <p className="settings-detail__hint">
        Sala cega ponta-a-ponta: os frames viajam selados em AES-256-GCM e o
        relay nunca vê o conteúdo. A chave da sala vive só no fragmento do link —
        compartilhe pelo QR ou copie o link. Nada de chave/token aparece em log.
      </p>

      {!flagOn && !running ? (
        <div className="settings-field">
          <div className="settings-pill-row">
            <span className="settings-chip settings-chip--warn">recurso desligado</span>
          </div>
          <p className="settings-field__note">
            O transporte relay está atrás da flag{' '}
            <code>{FEATURE_FLAG_IDS.remoteRelayTransport}</code> (default OFF,
            canal <code>dev</code>). Ative-a nas flags de produto para liberar
            start/stop e o pareamento. Ele nunca aponta para um relay público: a
            URL do relay é sempre explícita.
          </p>
        </div>
      ) : bridgeMissing ? (
        <div className="settings-field">
          <p className="settings-field__note settings-field__note--warning">
            Ponte do relay indisponível neste preload (remote.relay). Recarregue
            a janela; se persistir, o wiring do preload/tipos ainda não foi
            costurado.
          </p>
        </div>
      ) : (
        <>
          {!flagOn && running && (
            <p className="settings-field__note settings-field__note--warning">
              A flag do transporte foi desligada com uma sessão ativa. Ela
              bloqueia novas sessões; use <strong>Parar</strong> abaixo para
              encerrar a atual agora.
            </p>
          )}
          <div className="settings-pill-row">
            <span className={`settings-chip settings-chip--${chip.tone}`}>{chip.label}</span>
            {running && (
              <span className="settings-chip">
                {info?.guestCount ?? 0} guest(s)
              </span>
            )}
          </div>

          <div className="settings-field">
            <label className="settings-field__note" htmlFor="companion-relay-url">
              URL do relay — <code>wss://…</code> (só <code>ws://</code> para
              localhost). Rede de confiança: quem receber o link full controla a
              sessão.
            </label>
            <div className="settings-row" style={{ marginBottom: 0 }}>
              <input
                id="companion-relay-url"
                className="settings-input"
                placeholder="wss://relay.exemplo.dev"
                value={relayUrl}
                spellCheck={false}
                autoComplete="off"
                disabled={busy || running}
                onChange={(e) => setRelayUrl(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !running) void start();
                }}
                style={{ flex: 1 }}
              />
              {running ? (
                <button
                  type="button"
                  className="settings-btn"
                  disabled={busy}
                  onClick={() => void stop()}
                >
                  Parar
                </button>
              ) : (
                <button
                  type="button"
                  className="settings-btn settings-btn--primary"
                  disabled={busy || relayUrl.trim().length === 0}
                  onClick={() => void start()}
                >
                  Iniciar
                </button>
              )}
              <button
                type="button"
                className="settings-btn settings-btn--sm"
                disabled={busy}
                onClick={() => void refresh()}
              >
                Atualizar
              </button>
            </div>
          </div>

          {(uiError || info?.lastError) && (
            <p className="settings-field__note settings-field__note--warning" role="status">
              {uiError ?? info?.lastError}
            </p>
          )}

          {running && info?.fullLink && info.viewLink && (
            <>
              <p
                className="settings-field__note settings-field__note--warning"
                role="note"
                style={{ display: 'flex', gap: 6, alignItems: 'baseline' }}
              >
                <span className="settings-chip settings-chip--danger">segurança</span>
                <span>
                  Quem tiver o <strong>link full controla</strong> a sessão
                  (mesma autoridade do desktop). O <strong>link view só
                  observa</strong> — nada de escrita. Só compartilhe o full com
                  quem deve pilotar.
                </span>
              </p>

              <div
                style={{
                  display: 'flex',
                  gap: 16,
                  flexWrap: 'wrap',
                  margin: '10px 0 4px',
                }}
              >
                <figure style={{ margin: 0 }}>
                  <div className="settings-qr">
                    <QrCode
                      value={info.fullLink}
                      size={168}
                      label="QR do link full (controle da sessão)"
                    />
                  </div>
                  <figcaption className="settings-field__note" style={{ marginTop: 6 }}>
                    Full · controle
                  </figcaption>
                </figure>
                <figure style={{ margin: 0 }}>
                  <div className="settings-qr">
                    <QrCode
                      value={info.viewLink}
                      size={168}
                      label="QR do link view (somente leitura)"
                    />
                  </div>
                  <figcaption className="settings-field__note" style={{ marginTop: 6 }}>
                    View · somente leitura
                  </figcaption>
                </figure>
              </div>

              <ul className="settings-list">
                <LinkRow
                  title="Link full"
                  hint="Pareia com controle total — trate como segredo."
                  link={info.fullLink}
                  tone="danger"
                />
                <LinkRow
                  title="Link view"
                  hint="Pareia só para observar a sessão."
                  link={info.viewLink}
                  tone="ok"
                />
              </ul>
            </>
          )}
        </>
      )}
    </section>
  );
}
