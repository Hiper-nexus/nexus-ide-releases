import { useEffect, useState } from 'react';
import type { RemoteBridgeInfo } from '../../../shared/types';
import {
  REMOTE_DEVICE_SCOPES,
  type RemoteBridgeDeviceView,
  type RemoteBridgeStartRequest,
  type RemoteBridgeTailscaleDiagnostic,
  type RemoteBridgeTailscaleInfo,
  type RemoteDeviceScope,
} from '../../../shared/remote-types';
import { QrCode } from '../QrCode';

const TAILNET_DIAGNOSTIC: Record<RemoteBridgeTailscaleDiagnostic, string> = {
  'not-installed':
    'Tailscale não encontrado neste computador. Instale e entre no app para publicar no tailnet.',
  'not-logged-in': 'Tailscale instalado, mas sem login. Entre no app do Tailscale.',
  'not-running': 'Tailscale desconectado. Conecte pelo app do Tailscale.',
  'no-magicdns': 'MagicDNS desligado no tailnet. Ative em DNS no painel do Tailscale.',
  'serve-not-enabled':
    'HTTPS não está habilitado no tailnet. Ative os certificados HTTPS no painel do Tailscale.',
  'permission-denied':
    'Sem permissão para configurar o Serve. No Linux, rode: sudo tailscale set --operator=$USER',
  'port-in-use':
    'A porta 443 do Serve já tem outra configuração neste computador. O Nexus não a substitui.',
  timeout: 'O Tailscale não respondeu a tempo. Inicie de novo para tentar outra vez.',
  'probe-failed':
    'Serve configurado, mas o endereço HTTPS ainda não respondeu. Na primeira vez o certificado pode levar alguns segundos.',
  unknown: 'O Tailscale recusou o comando.',
};

// MOB-12 (F-1022): o que cada escopo libera para o aparelho.
const SCOPE_COPY: Record<RemoteDeviceScope, { label: string; detail: string }> = {
  read: {
    label: 'Ver',
    detail: 'Panes, saída do terminal, missões, Git e arquivos, só leitura.',
  },
  input: {
    label: 'Enviar comandos',
    detail: 'Uma linha completa por vez no terminal e o tamanho do pane.',
  },
  approve: {
    label: 'Aprovar',
    detail: 'Responder aos pedidos de aprovação dos agentes.',
  },
  close: { label: 'Fechar panes', detail: 'Encerrar um pane pelo celular.' },
};

function scopeSummary(scopes: readonly RemoteDeviceScope[] | undefined): string {
  if (!scopes) return '—';
  if (scopes.length === 0) return 'nenhuma (só o status)';
  return scopes.map((scope) => SCOPE_COPY[scope].label).join(' · ');
}

function toggleScope(
  scopes: readonly RemoteDeviceScope[],
  scope: RemoteDeviceScope,
  on: boolean,
): RemoteDeviceScope[] {
  return REMOTE_DEVICE_SCOPES.filter((item) => (item === scope ? on : scopes.includes(item)));
}

function ScopeToggles({
  label,
  scopes,
  onChange,
  showDetail,
}: {
  label: string;
  scopes: readonly RemoteDeviceScope[];
  onChange: (next: RemoteDeviceScope[]) => void;
  showDetail: boolean;
}) {
  return (
    <div className="settings-toggle-list" role="group" aria-label={label}>
      {REMOTE_DEVICE_SCOPES.map((scope) => (
        <label key={scope} className="settings-toggle-row">
          <span className="settings-toggle-row__copy">
            <strong>{SCOPE_COPY[scope].label}</strong>
            <span>{showDetail ? SCOPE_COPY[scope].detail : ''}</span>
          </span>
          <input
            type="checkbox"
            aria-label={`${label}: ${SCOPE_COPY[scope].label}`}
            checked={scopes.includes(scope)}
            onChange={(event) => onChange(toggleScope(scopes, scope, event.target.checked))}
          />
          <span className="settings-toggle-row__control" aria-hidden="true" />
        </label>
      ))}
    </div>
  );
}

function deviceKey(device: RemoteBridgeDeviceView): string {
  return device.keyFingerprint.slice(0, 12).replace(/(.{4})(?=.)/g, '$1 ');
}
// MOB-12 (fim)

function tailnetDescription(
  tailnet: RemoteBridgeTailscaleInfo | null,
  publishing: boolean,
): string {
  if (publishing) return 'Publicando no tailnet…';
  if (!tailnet) return 'Verificando o Tailscale neste computador…';
  if (tailnet.httpsUrl && tailnet.status === 'available') {
    return `Publicado em ${tailnet.httpsUrl} com certificado válido do tailnet.`;
  }
  if (tailnet.diagnostic) return TAILNET_DIAGNOSTIC[tailnet.diagnostic];
  return (
    'Certificado HTTPS válido (*.ts.net) e acesso fora da LAN sem abrir porta. ' +
    'Vale quando você inicia o bridge; o pareamento do aparelho continua obrigatório.'
  );
}

/**
 * "Celular na rede local": bridge LAN (código de pareamento + QR) que antes
 * morava em Máquinas remotas. Vive na página Celular, ao lado do relay, para
 * que o celular apareça num lugar só. O comportamento e as chamadas IPC são
 * os mesmos de antes (`window.nexus.remote.bridge*`).
 */
export function LocalPhoneBridgeCard() {
  const [info, setInfo] = useState<RemoteBridgeInfo | null>(null);
  // Última leitura do Tailscale: rotate/revoke não a repetem, e o toggle não
  // deve piscar por isso.
  const [tailnet, setTailnet] = useState<RemoteBridgeTailscaleInfo | null>(null);
  const [publishChoice, setPublishChoice] = useState<boolean | null>(null);
  const [starting, setStarting] = useState(false);
  // MOB-12: escopos do próximo código (Iniciar / Novo código); nasce com todos.
  const [nextScopes, setNextScopes] = useState<RemoteDeviceScope[]>([...REMOTE_DEVICE_SCOPES]);
  const [scopeError, setScopeError] = useState('');
  const scopeRequest =
    nextScopes.length === REMOTE_DEVICE_SCOPES.length ? {} : { scopes: nextScopes };

  const applyInfo = (next: RemoteBridgeInfo) => {
    setInfo(next);
    if (next.tailscale) setTailnet(next.tailscale);
  };

  useEffect(() => {
    let cancelled = false;
    void window.nexus.remote.bridgeStatus().then((bridge) => {
      if (!cancelled) applyInfo(bridge);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Nasce LIGADO quando a CLI existe e está logada; só age no start.
  const tailnetUsable = tailnet !== null && tailnet.status !== 'unavailable';
  const publishTailnet = tailnetUsable && (publishChoice ?? true);

  const start = async (request: RemoteBridgeStartRequest) => {
    setStarting(true);
    try {
      applyInfo(
        await window.nexus.remote.bridgeStart({
          ...request,
          ...scopeRequest,
          tailscale: publishTailnet,
        }),
      );
    } finally {
      setStarting(false);
    }
  };

  // LAN de verdade antes do IP do tailnet (este usa o certificado self-signed).
  const lanWss = info?.endpoints
    ? (
        info.endpoints.find((endpoint) => endpoint.label === 'Rede local') ??
        info.endpoints.find((endpoint) => endpoint.label === 'Tailscale IP')
      )?.url
    : info?.urls.find((u) => !u.includes('127.0.0.1'));
  const lanUrl = lanWss?.replace('wss://', 'https://');
  const tailnetUrl = info?.tailscale?.httpsUrl;
  const phoneUrl =
    (info?.tailscale?.status === 'available' ? tailnetUrl : undefined) ?? lanUrl ?? tailnetUrl;
  const urlText = info?.endpoints?.length
    ? info.endpoints.map((endpoint) => `${endpoint.label}: ${endpoint.url}`).join(' · ')
    : info?.urls.join(' · ');

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

      <div className="settings-toggle-list">
        <label className="settings-toggle-row">
          <span className="settings-toggle-row__copy">
            <strong>Publicar no tailnet (HTTPS)</strong>
            <span>{tailnetDescription(tailnet, starting && publishTailnet)}</span>
          </span>
          <input
            type="checkbox"
            aria-label="Publicar no tailnet (HTTPS)"
            checked={publishTailnet}
            disabled={!tailnetUsable || starting}
            onChange={(event) => setPublishChoice(event.target.checked)}
          />
          <span className="settings-toggle-row__control" aria-hidden="true" />
        </label>
      </div>

      <p className="settings-card__note">
        Permissões do próximo aparelho: valem para o código gerado em Iniciar ou Novo código.
      </p>
      <ScopeToggles
        label="Permissões do próximo aparelho"
        scopes={nextScopes}
        onChange={setNextScopes}
        showDetail
      />

      <div className="settings-action-row" role="group" aria-label="Ações do bridge">
        <button
          type="button"
          className="settings-btn"
          disabled={starting}
          onClick={() => void start({})}
          title="Este computador (127.0.0.1); com o tailnet ligado, também os aparelhos do seu tailnet"
        >
          Iniciar neste computador
        </button>
        <button
          type="button"
          className="settings-btn settings-btn--primary"
          disabled={starting}
          onClick={() => void start({ host: '0.0.0.0' })}
          title="Expõe na rede local para o celular conectar — só faça em redes de confiança"
        >
          Iniciar na rede local
        </button>
        <button
          type="button"
          className="settings-btn"
          onClick={async () => {
            applyInfo(await window.nexus.remote.bridgeRotatePairing(scopeRequest));
          }}
        >
          Novo código
        </button>
        <button
          type="button"
          className="settings-btn"
          onClick={async () => {
            applyInfo(await window.nexus.remote.bridgeRevokeTokens());
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
            <div className="settings-meta settings-meta--wide">
              <span className="settings-meta__label">Permissões do código</span>
              <strong className="settings-meta__value">
                {info.pairingCode ? scopeSummary(info.pairingScopes) : '—'}
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
                {urlText || 'sem URL ativa'}
              </strong>
            </div>
            <div className="settings-meta settings-meta--wide">
              <span className="settings-meta__label">Certificado</span>
              <strong className="settings-meta__value settings-meta__value--mono">
                {info.certFingerprint ?? '—'}
              </strong>
            </div>
          </div>

          {info.devices && info.devices.length > 0 ? (
            <div className="settings-card__body">
              <p className="settings-card__note">
                Aparelhos pareados: mudar uma permissão vale já no próximo pedido do aparelho.
              </p>
              {scopeError ? (
                <p className="settings-card__note" role="alert">
                  {scopeError}
                </p>
              ) : null}
              {info.devices.map((device) => (
                <div key={device.id} className="settings-card__body">
                  <p className="settings-card__note">
                    <strong>Aparelho {deviceKey(device)}</strong>
                    {` · pareado em ${new Date(device.pairedAt).toLocaleString('pt-BR')} · `}
                    {device.connected ? 'conectado' : 'desconectado'}
                  </p>
                  <ScopeToggles
                    label={`Permissões do aparelho ${deviceKey(device)}`}
                    scopes={device.scopes}
                    showDetail={false}
                    onChange={async (scopes) => {
                      const next = await window.nexus.remote.bridgeSetDeviceScopes({
                        deviceId: device.id,
                        scopes,
                      });
                      setScopeError(
                        next.error
                          ? 'Não deu para mudar as permissões: o aparelho não está mais pareado.'
                          : '',
                      );
                      applyInfo(next);
                    }}
                  />
                </div>
              ))}
            </div>
          ) : null}

          {info.urls.length > 0 ? (
            <div className="settings-card__aside">
              <p className="settings-card__note">
                {phoneUrl
                  ? `Abra no celular: ${phoneUrl}`
                  : 'Só localhost — inicie na rede local ou publique no tailnet.'}
              </p>
              {phoneUrl ? (
                <div className="settings-qr">
                  <QrCode
                    value={`${phoneUrl}#code=${info.pairingCode ?? ''}`}
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
