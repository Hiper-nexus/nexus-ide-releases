import { useEffect, useRef, useState } from 'react';
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

// F-1478: "Online" só diz que o bridge escuta. Estes textos dizem ao leigo o
// que conferir quando o celular não conecta.
const STATUS_POLL_MS = 4_000;
const LAST_PAIRED_URL_KEY = 'nexus.phoneBridge.lastPairedUrl.v1';
const NOBODY_CONNECTED_LAN =
  'Nenhum celular conectou ainda. No celular: mesmo Wi-Fi (sem rede de convidado), abra o link ' +
  'ou o QR e aceite o aviso de certificado. Se nada conectar, o firewall do computador pode ter ' +
  'bloqueado — no Windows, permita o NexusIDE em redes privadas.';
const NOBODY_CONNECTED_TAILNET =
  'Nenhum celular conectou ainda. No celular: entre no app do Tailscale com a mesma conta e ' +
  'abra o link ou o QR.';
const CODE_EXPIRED = ' O código venceu (vale 5 minutos): toque em Novo código antes de ler o QR.';
const CERT_WARNING =
  'O navegador do celular vai avisar “conexão não privada”: é o certificado local do Nexus. ' +
  'Toque em Avançado → continuar.';

function readLastPairedUrl(): string | null {
  try {
    return localStorage.getItem(LAST_PAIRED_URL_KEY);
  } catch {
    return null;
  }
}

function saveLastPairedUrl(url: string | null): void {
  try {
    if (url) localStorage.setItem(LAST_PAIRED_URL_KEY, url);
    else localStorage.removeItem(LAST_PAIRED_URL_KEY);
  } catch {
    /* storage bloqueado: só perde o aviso de endereço mudado */
  }
}

function urlOrigin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

/** Tira o envelope do Electron ("Error invoking remote method '…': Error: "). */
function bridgeErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replace(/^Error invoking remote method '[^']*': (?:Error: )?/, '');
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

  const [lastPairedUrl, setLastPairedUrl] = useState(readLastPairedUrl);
  // F-1478: uma leitura periódica não sobrescreve a resposta de uma ação.
  const infoSeq = useRef(0);

  const applyInfo = (next: RemoteBridgeInfo) => {
    infoSeq.current += 1;
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

  // F-1478: com o bridge no ar, relê o estado para o diagnóstico acompanhar o
  // celular que pareia, conecta ou cai.
  const running = info?.running === true;
  useEffect(() => {
    if (!running) return undefined;
    let cancelled = false;
    const timer = setInterval(() => {
      const seq = infoSeq.current;
      window.nexus.remote.bridgeStatus().then(
        (bridge) => {
          if (!cancelled && infoSeq.current === seq) applyInfo(bridge);
        },
        () => undefined,
      );
    }, STATUS_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [running]);

  // Nasce LIGADO quando a CLI existe e está logada; só age no start.
  const tailnetUsable = tailnet !== null && tailnet.status !== 'unavailable';
  const publishTailnet = tailnetUsable && (publishChoice ?? true);

  const [bridgeError, setBridgeError] = useState('');
  // F-1478: Iniciar/Parar dizem quando falham e mostram o estado real depois.
  const runBridgeAction = async (action: () => Promise<RemoteBridgeInfo>, failure: string) => {
    setStarting(true);
    setBridgeError('');
    try {
      applyInfo(await action());
    } catch (error) {
      setBridgeError(`${failure}: ${bridgeErrorMessage(error)}`);
      try {
        applyInfo(await window.nexus.remote.bridgeStatus());
      } catch {
        // Sem estado novo: fica o último.
      }
    } finally {
      setStarting(false);
    }
  };

  const start = (request: RemoteBridgeStartRequest) =>
    runBridgeAction(
      () =>
        window.nexus.remote.bridgeStart({
          ...request,
          ...scopeRequest,
          tailscale: publishTailnet,
        }),
      'Não deu para iniciar o bridge',
    );

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

  // F-1478: diagnóstico do "ninguém conectou".
  const devices = info?.devices ?? [];
  const deviceConnected = devices.some((device) => device.connected);
  // A URL que um aparelho conectado de fato usou (o Host que chegou no bridge).
  const usedUrl = devices.find((device) => device.connected && device.connectedUrl)?.connectedUrl;
  const viaTailnet = Boolean(phoneUrl) && phoneUrl === tailnetUrl;
  useEffect(() => {
    if (!usedUrl || usedUrl === lastPairedUrl) return;
    saveLastPairedUrl(usedUrl);
    setLastPairedUrl(usedUrl);
  }, [usedUrl, lastPairedUrl]);
  let diagnosis: string | null = null;
  if (running && phoneUrl) {
    if (info.tokenCount === 0 && !info.clientCount) {
      diagnosis =
        (viaTailnet ? NOBODY_CONNECTED_TAILNET : NOBODY_CONNECTED_LAN) +
        (info.pairingCode ? '' : CODE_EXPIRED);
    } else if (devices.length > 0 && !deviceConnected) {
      diagnosis =
        lastPairedUrl && urlOrigin(lastPairedUrl) !== urlOrigin(phoneUrl)
          ? `O endereço mudou desde o último pareamento (era ${lastPairedUrl}, agora ${phoneUrl}): ` +
            'o celular ainda procura o antigo. Gere um QR novo em Novo código e leia de novo no celular.'
          : 'Aparelho pareado, mas desconectado. No celular, abra o link de novo no mesmo Wi-Fi; ' +
            'se não voltar, gere um QR novo em Novo código e leia de novo.';
    }
  }

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
          onClick={() => void start({ host: '127.0.0.1' })}
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
          disabled={starting || !running}
          onClick={() =>
            void runBridgeAction(
              () => window.nexus.remote.bridgeStop(),
              'Não deu para parar o bridge',
            )
          }
          title="Fecha o bridge: ninguém mais conecta até você iniciar de novo"
        >
          Parar
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
            saveLastPairedUrl(null);
            setLastPairedUrl(null);
          }}
        >
          Revogar acessos
        </button>
      </div>

      {bridgeError ? (
        <p className="settings-card__note" role="alert">
          {bridgeError}
        </p>
      ) : null}

      {info ? (
        <div className="settings-card__body">
          {diagnosis ? (
            <p className="settings-card__note" role="status">
              {diagnosis}
            </p>
          ) : null}
          {running && info.portFallbackFrom ? (
            <p className="settings-card__note" role="status">
              {`A porta ${info.portFallbackFrom} não estava livre (outro programa ou o Windows a reservou); o bridge abriu na porta ${info.port} só desta vez e tenta a ${info.portFallbackFrom} de novo no próximo início. Um QR lido antes não vale mais: leia este.`}
            </p>
          ) : null}
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
              {phoneUrl && !viaTailnet ? (
                <p className="settings-card__note">
                  {CERT_WARNING}
                  {tailnetUsable
                    ? ' Sem esse aviso: ligue “Publicar no tailnet” acima e toque em Iniciar de novo.'
                    : ''}
                </p>
              ) : null}
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
