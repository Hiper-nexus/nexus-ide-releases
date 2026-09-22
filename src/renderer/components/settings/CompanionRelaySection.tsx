import { useCallback, useEffect, useRef, useState } from 'react';
import { FEATURE_FLAG_IDS } from '../../../shared/feature-flags';
import type {
  CompanionRelayStartRequest,
  CompanionRelayTransportInfo,
} from '../../../shared/companion-relay-types';
import { useProductFlags } from '../../lib/use-product-flags';
import { MainGeneratedQr } from '../MainGeneratedQr';
import { EmptyState } from '../ActionCard';
import { SettingsSectionTitle } from './SettingsSectionTitle';
import { LocalPhoneBridgeCard } from './LocalPhoneBridgeCard';

const PRODUCTION_RELAY_URL = 'wss://relay.nexuside.app';

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
      <div className="relay-link__row">
        <input
          className="settings-input relay-link__input"
          readOnly
          value={link}
          aria-label={`${title} (link de pareamento)`}
          onFocus={(e) => e.currentTarget.select()}
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
    if (!bridge) return;
    setBusy(true);
    setUiError(null);
    try {
      const next = await bridge.start({ relayUrl: PRODUCTION_RELAY_URL });
      setInfo(next);
      if (next.error) setUiError(next.error);
    } catch (err) {
      setUiError(err instanceof Error ? err.message : 'falha ao iniciar');
    } finally {
      setBusy(false);
    }
  }, []);

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
    <section className="sys-section">
      <SettingsSectionTitle>Acesso pelo celular</SettingsSectionTitle>
      <p className="settings-detail__hint">
        Conecte seu celular pelo QR code ou link. A conexão tem criptografia
        de ponta a ponta; o servidor intermediário não lê o conteúdo.
      </p>

      {!flagOn && !running ? (
        <EmptyState
          icon="link"
          title="Acesso pelo celular desligado"
          body={
            <p>
              Ative Acesso pelo celular em Experimental para iniciar uma
              conexão. O serviço exige um endereço de servidor configurado.
            </p>
          }
        />
      ) : bridgeMissing ? (
        <EmptyState
          icon="warn"
          title="Serviço de conexão indisponível"
          role="alert"
          body={
            <p>
              Não foi possível acessar o serviço de conexão. Reabra o app e
              tente novamente.
            </p>
          }
        />
      ) : (
        <>
          {!flagOn && running && (
            <p className="settings-field__note settings-field__note--warning" role="status">
              O recurso foi desligado com uma conexão ativa. Isso
              bloqueia novas sessões; use <strong>Parar</strong> abaixo para
              encerrar a atual agora.
            </p>
          )}

          <div className="relay-conn">
            <div className="relay-conn__row">
              <span className={`settings-chip settings-chip--${chip.tone}`}>{chip.label}</span>
              {running && (
                <span className="settings-chip">
                  {info?.guestCount ?? 0} dispositivos conectados
                </span>
              )}
            </div>
            <p className="settings-field__note">
              Relay NexusIDE protegido. O endereço é configurado automaticamente;
              quem receber o QR Full controla a sessão.
            </p>
            <div className="relay-conn__row">
              <code className="relay-conn__url">{PRODUCTION_RELAY_URL}</code>
              {running ? (
                <button
                  type="button"
                  className="settings-btn"
                  disabled={busy}
                  onClick={() => void stop()}
                >
                  {busy ? 'Trabalhando…' : 'Parar'}
                </button>
              ) : (
                <button
                  type="button"
                  className="settings-btn settings-btn--primary"
                  disabled={busy}
                  onClick={() => void start()}
                >
                  {busy ? 'Iniciando…' : 'Iniciar Companion'}
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
              >
                <span className="settings-chip settings-chip--danger">segurança</span>{' '}
                Quem tiver o <strong>link full controla</strong> a sessão
                (mesma autoridade do desktop). O <strong>link view só
                observa</strong> — nada de escrita. Só compartilhe o full com
                quem deve pilotar.
              </p>

              <div className="relay-qrs">
                <figure className="relay-qr">
                  <div className="settings-qr">
                    <MainGeneratedQr
                      svg={info.qrSvgFull}
                      size={168}
                      label="QR do link full (controle da sessão)"
                    />
                  </div>
                  <figcaption>
                    <span className="settings-chip settings-chip--danger">controle</span>
                    QR Full
                  </figcaption>
                </figure>
                <figure className="relay-qr">
                  <div className="settings-qr">
                    <MainGeneratedQr
                      svg={info.qrSvgView}
                      size={168}
                      label="QR do link view (somente leitura)"
                    />
                  </div>
                  <figcaption>
                    <span className="settings-chip settings-chip--ok">somente leitura</span>
                    QR View
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

      <LocalPhoneBridgeCard />
    </section>
  );
}
