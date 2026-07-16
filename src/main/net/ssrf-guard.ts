import dns from 'node:dns';
import net from 'node:net';
import {
  classifyBrowserAddress,
  type BrowserAddressClass,
} from '../browser/url-policy';

/**
 * Shared SSRF guard for main-process outbound connections initiated on behalf of
 * the renderer/agents (port forwards, pet-gallery imports, …). The main process
 * has full network reach and no renderer CSP, so a renderer/agent-supplied host
 * must never be allowed to target cloud-metadata / link-local / reserved
 * destinations. Loopback + private (RFC1918) + CGNAT stay allowed so legitimate
 * LAN / dev-server / self-host targets keep working.
 */
export const FORBIDDEN_NET_CLASSES: ReadonlySet<BrowserAddressClass> = new Set([
  'metadata',
  'link-local',
  'unspecified',
  'multicast',
  'documentation',
  'reserved',
]);

export const METADATA_HOSTNAMES: ReadonlySet<string> = new Set([
  'metadata.google.internal',
  'metadata.google',
  'metadata.goog',
  'metadata',
  'metadata.azure.internal',
  'instance-data.ec2.internal',
]);

/** Strip the surrounding brackets URL.hostname keeps on IPv6 literals. */
function unbracket(host: string): string {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}

export type NetworkTargetCheck =
  | { ok: true; address: string; addresses: string[] }
  | { ok: false; error: string };

/** Resolve a hostname to its IP addresses. Injectable for tests. */
export type HostLookup = (host: string) => Promise<string[]>;

const defaultLookup: HostLookup = async (host) =>
  (await dns.promises.lookup(host, { all: true })).map((r) => r.address);

export function isForbiddenAddressClass(cls: BrowserAddressClass): boolean {
  return FORBIDDEN_NET_CLASSES.has(cls);
}

/**
 * Resolve `host` and reject metadata/link-local/reserved destinations. Returns
 * the resolved address list plus a single pinned address (the first), which
 * callers may connect to directly to defeat DNS rebinding. `lookup` is
 * injectable so callers/tests can supply a deterministic resolver.
 */
export async function checkNetworkTarget(
  host: string,
  lookup: HostLookup = defaultLookup,
): Promise<NetworkTargetCheck> {
  const trimmed = unbracket(host.trim());
  const lower = trimmed.toLowerCase().replace(/\.$/, '');
  if (METADATA_HOSTNAMES.has(lower)) {
    return { ok: false, error: 'destino bloqueado (endpoint de metadata)' };
  }
  if (net.isIP(trimmed)) {
    const cls = classifyBrowserAddress(trimmed);
    if (isForbiddenAddressClass(cls)) {
      return { ok: false, error: `destino bloqueado (${cls})` };
    }
    return { ok: true, address: trimmed, addresses: [trimmed] };
  }
  let addresses: string[];
  try {
    addresses = await lookup(trimmed);
  } catch {
    return { ok: false, error: `falha ao resolver ${trimmed}` };
  }
  if (addresses.length === 0) {
    return { ok: false, error: `sem endereço para ${trimmed}` };
  }
  for (const address of addresses) {
    if (isForbiddenAddressClass(classifyBrowserAddress(address))) {
      return {
        ok: false,
        error: 'destino bloqueado (resolve para faixa privilegiada/metadata)',
      };
    }
  }
  return { ok: true, address: addresses[0], addresses };
}
