import { useEffect, useState } from 'react';
import {
  MAIN_HEARTBEAT_TICK_MS,
  createMainHeartbeatMonitor,
} from '../lib/main-heartbeat';
import { setVisibleInterval } from '../lib/visible-interval';
import { PixelIcon } from './PixelIcon';

/**
 * `true` enquanto o main está há 10 s+ sem atender o ping (F-764 C.7). Sem a
 * ponte `app.heartbeat` (preload antigo, testes) nunca acusa nada. Com a
 * janela oculta o relógio dorme; ao voltar, confere na hora.
 */
export function useMainBusy(): boolean {
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const app = typeof window === 'undefined' ? undefined : window.nexus?.app;
    if (typeof app?.heartbeat !== 'function') return undefined;
    const monitor = createMainHeartbeatMonitor({
      ping: () => app.heartbeat(),
      onBusyChange: setBusy,
    });
    const stop = setVisibleInterval(() => monitor.tick(), MAIN_HEARTBEAT_TICK_MS);
    return () => {
      stop();
      monitor.dispose();
    };
  }, []);
  return busy;
}

/**
 * Faixa de estado no topo da janela quando o main não responde. Só
 * informa: não captura clique, não oferece "forçar saída" (sem auto-kill) e
 * some sozinha quando o main volta. A região viva fica montada o tempo todo
 * para o leitor de tela anunciar a mudança.
 */
export function MainBusyBanner() {
  const busy = useMainBusy();
  return (
    <div className="main-busy" role="status" aria-live="polite">
      {busy ? (
        <div className="main-busy__band">
          <span className="main-busy__icon" aria-hidden="true">
            <PixelIcon name="warn" size={12} />
          </span>
          <span className="main-busy__title">
            Nexus ocupado — capturando diagnóstico
          </span>
          <span className="main-busy__detail">
            A janela volta a responder sozinha.
          </span>
        </div>
      ) : null}
    </div>
  );
}
