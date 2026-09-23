import { useEffect, useState } from 'react';
import type { RemoteBridgeInfo } from '../../../shared/types';
import { QrCode } from '../QrCode';

/**
 * "Celular na rede local": bridge LAN (código de pareamento + QR) que antes
 * morava em Máquinas remotas. Vive na página Celular, ao lado do relay, para
 * que o celular apareça num lugar só. O comportamento e as chamadas IPC são
 * os mesmos de antes (`window.nexus.remote.bridge*`).
 */
export function LocalPhoneBridgeCard() {
  const [info, setInfo] = useState<RemoteBridgeInfo | null>(null);

  useEffect(() => {
    let cancelled = false;
    void window.nexus.remote.bridgeStatus().then((bridge) => {
      if (!cancelled) setInfo(bridge);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const lanUrl = info?.urls
    .filter((u) => !u.includes('127.0.0.1'))
    .map((u) => u.replace('wss://', 'https://'))[0];

  return (
    <section className="settings-card" aria-labelledby="remote-bridge-title">
      <div className="settings-card__head">
        <div className="settings-card__titles">
          <h3 id="remote-bridge-title" className="settings-card__title">
            Celular na rede local
          </h3>
          <p className="settings-card__subtitle">
            Conecte o celular na mesma rede usando o código ou QR code.
          </p>
        </div>
        <span
          className={`settings-status-pill ${
            info?.running ? 'settings-status-pill--ok' : 'settings-status-pill--warn'
          }`}
          role="status"
        >
          <span
            className={`catalog-dot ${info?.running ? 'catalog-dot--ok' : 'catalog-dot--warn'}`}
            aria-hidden="true"
          />
          {info?.running ? 'Online' : 'Offline'}
        </span>
      </div>

      <div className="settings-action-row" role="group" aria-label="Ações do bridge">
        <button
          type="button"
          className="settings-btn"
          onClick={async () => {
            setInfo(await window.nexus.remote.bridgeStart());
          }}
          title="Só este computador (127.0.0.1)"
        >
          Iniciar neste computador
        </button>
        <button
          type="button"
          className="settings-btn settings-btn--primary"
          onClick={async () => {
            setInfo(await window.nexus.remote.bridgeStart({ host: '0.0.0.0' }));
          }}
          title="Expõe na rede local para o celular conectar — só faça em redes de confiança"
        >
          Iniciar na rede local
        </button>
        <button
          type="button"
          className="settings-btn"
          onClick={async () => {
            setInfo(await window.nexus.remote.bridgeRotatePairing());
          }}
        >
          Novo código
        </button>
        <button
          type="button"
          className="settings-btn"
          onClick={async () => {
            setInfo(await window.nexus.remote.bridgeRevokeTokens());
          }}
        >
          Revogar acessos
        </button>
      </div>

      {info ? (
        <div className="settings-card__body">
          <div className="settings-meta-grid">
            <div className="settings-meta">
              <span className="settings-meta__label">Código</span>
              <strong className="settings-meta__value settings-meta__value--mono">
                {info.pairingCode ?? '------'}
              </strong>
            </div>
            <div className="settings-meta">
              <span className="settings-meta__label">Tokens</span>
              <strong className="settings-meta__value">{info.tokenCount}</strong>
            </div>
            <div className="settings-meta">
              <span className="settings-meta__label">Clientes</span>
              <strong className="settings-meta__value">{info.clientCount}</strong>
            </div>
            <div className="settings-meta settings-meta--wide">
              <span className="settings-meta__label">URL</span>
              <strong className="settings-meta__value settings-meta__value--mono">
                {info.urls.join(' · ') || 'sem URL ativa'}
              </strong>
            </div>
            <div className="settings-meta settings-meta--wide">
              <span className="settings-meta__label">Certificado</span>
              <strong className="settings-meta__value settings-meta__value--mono">
                {info.certFingerprint ?? '—'}
              </strong>
            </div>
          </div>

          {info.urls.length > 0 ? (
            <div className="settings-card__aside">
              <p className="settings-card__note">
                {lanUrl
                  ? `Abra no celular: ${lanUrl}`
                  : 'Só localhost — inicie em LAN e conecte na mesma rede.'}
              </p>
              {lanUrl ? (
                <div className="settings-qr">
                  <QrCode
                    value={`${lanUrl}#code=${info.pairingCode ?? ''}`}
                    size={180}
                    label="QR code para parear o celular"
                  />
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : (
        <p className="settings-card__note">Carregando estado do bridge…</p>
      )}
    </section>
  );
}
