/**
 * Local TCP port forward (B6): listen on localhost:localPort and proxy to remoteHost:remotePort.
 * Used to open remote/dev-server ports in the Nexus browser.
 * Pure Node net — no SSH tunnel required when remote is already reachable (or via SSH LocalForward later).
 */
import net from 'node:net';
import type { PortForwardInfo } from '../../shared/integrations-types';
import { checkNetworkTarget } from '../net/ssrf-guard';

/**
 * SSRF guard (H4): a port forward must never let a renderer/agent proxy the
 * main process to cloud-metadata / link-local / reserved destinations. Loopback,
 * private (RFC1918) and CGNAT stay allowed so forwarding a real remote/LAN dev
 * server keeps working. The resolved address is pinned to defeat DNS rebinding.
 */

type ForwardHandle = {
  info: PortForwardInfo;
  server: net.Server;
};

const active = new Map<string, ForwardHandle>();
let seq = 0;

export function listPortForwards(): PortForwardInfo[] {
  return [...active.values()].map((h) => h.info);
}

export function closePortForward(id: string): boolean {
  const h = active.get(id);
  if (!h) return false;
  try {
    h.server.close();
  } catch {
    // ignore
  }
  active.delete(id);
  return true;
}

export function closeAllPortForwards(): void {
  for (const id of [...active.keys()]) closePortForward(id);
}

export async function startPortForward(input: {
  localPort: number;
  remoteHost: string;
  remotePort: number;
  label?: string;
}): Promise<
  { ok: true; info: PortForwardInfo } | { ok: false; error: string }
> {
  for (const h of active.values()) {
    if (h.info.localPort === input.localPort) {
      return { ok: false, error: `local port ${input.localPort} already forwarded` };
    }
  }

  const target = await checkNetworkTarget(input.remoteHost);
  if (!target.ok) return { ok: false, error: target.error };
  const pinnedHost = target.address;

  const id = `pf-${++seq}`;
  const info: PortForwardInfo = {
    id,
    localPort: input.localPort,
    remoteHost: input.remoteHost,
    remotePort: input.remotePort,
    label: input.label,
    localUrl: `http://127.0.0.1:${input.localPort}`,
  };

  const server = net.createServer((client) => {
    const upstream = net.connect(input.remotePort, pinnedHost);
    client.pipe(upstream);
    upstream.pipe(client);
    client.on('error', () => upstream.destroy());
    upstream.on('error', () => client.destroy());
  });

  let listenError: string | null = null;
  server.once('error', (err) => {
    listenError = err instanceof Error ? err.message : String(err);
  });
  try {
    server.listen(input.localPort, '127.0.0.1');
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
  // Give Node a tick to surface EADDRINUSE on the same event loop turn.
  if (listenError) {
    return { ok: false, error: listenError };
  }

  server.on('error', (err) => {
    console.warn('[port-forward]', info.id, err.message);
    active.delete(id);
    try {
      server.close();
    } catch {
      // ignore
    }
  });

  active.set(id, { info, server });
  return { ok: true, info };
}
