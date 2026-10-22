import dns from 'node:dns';
import net from 'node:net';
import { redactVisibleSecrets } from '../../shared/vision-ipc';

export type BrowserAddressClass =
  | 'public'
  | 'loopback'
  | 'private'
  | 'carrier-grade-nat'
  | 'link-local'
  | 'metadata'
  | 'unspecified'
  | 'multicast'
  | 'documentation'
  | 'reserved';

export type BrowserUrlBlockKind =
  | 'invalid-url'
  | 'unsafe-scheme'
  | 'embedded-credentials'
  | 'private-network'
  | 'forbidden-network'
  | 'dns-failure';

export interface BrowserUrlAllowed {
  allowed: true;
  normalizedUrl: string;
  targetKey: string;
  addresses: string[];
  addressClasses: BrowserAddressClass[];
}

export interface BrowserUrlBlocked {
  allowed: false;
  normalizedUrl?: string;
  targetKey?: string;
  kind: BrowserUrlBlockKind;
  reason: string;
  addresses?: string[];
  addressClasses?: BrowserAddressClass[];
}

export type BrowserUrlDecision = BrowserUrlAllowed | BrowserUrlBlocked;
export type BrowserAddressResolver = (hostname: string) => Promise<string[]>;

export interface BrowserUrlPolicyOptions {
  allowAboutBlank?: boolean;
  allowPrivateNetwork?: boolean;
  isTrustedPrivateUrl?: (url: URL) => boolean;
  resolver?: BrowserAddressResolver;
  requestProtocols?: boolean;
}

const METADATA_HOSTS = new Set([
  'metadata.google.internal',
  'metadata.google',
  'metadata.goog',
  'instance-data.ec2.internal',
  'metadata.azure.internal',
]);

const METADATA_IPV4 = new Set([
  '169.254.169.254',
  '169.254.170.2',
  '100.100.100.200',
]);
const METADATA_IPV6 = new Set(['fd00:ec2::254']);

const PRIVATE_HOST_SUFFIXES = [
  '.localhost',
  '.local',
  '.internal',
  '.home.arpa',
];

function cleanHostname(hostname: string): string {
  return hostname
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '')
    .split('%')[0];
}

function ipv4Number(address: string): number | null {
  if (net.isIP(address) !== 4) return null;
  return address
    .split('.')
    .map(Number)
    .reduce((value, octet) => value * 256 + octet, 0) >>> 0;
}

function inV4Range(value: number, base: number, bits: number): boolean {
  if (bits === 0) return true;
  const mask = (0xffffffff << (32 - bits)) >>> 0;
  return (value & mask) === (base & mask);
}

function classifyIpv4(address: string): BrowserAddressClass {
  if (METADATA_IPV4.has(address)) return 'metadata';
  const value = ipv4Number(address);
  if (value === null) return 'reserved';

  if (inV4Range(value, 0x00000000, 8)) return 'unspecified';
  if (inV4Range(value, 0x0a000000, 8)) return 'private';
  if (inV4Range(value, 0x64400000, 10)) return 'carrier-grade-nat';
  if (inV4Range(value, 0x7f000000, 8)) return 'loopback';
  if (inV4Range(value, 0xa9fe0000, 16)) return 'link-local';
  if (inV4Range(value, 0xac100000, 12)) return 'private';
  if (inV4Range(value, 0xc0000000, 24)) return 'reserved';
  if (inV4Range(value, 0xc0000200, 24)) return 'documentation';
  if (inV4Range(value, 0xc0a80000, 16)) return 'private';
  if (inV4Range(value, 0xc6120000, 15)) return 'reserved';
  if (inV4Range(value, 0xc6336400, 24)) return 'documentation';
  if (inV4Range(value, 0xcb007100, 24)) return 'documentation';
  if (inV4Range(value, 0xe0000000, 4)) return 'multicast';
  if (inV4Range(value, 0xf0000000, 4)) return 'reserved';
  return 'public';
}

function ipv6Bytes(address: string): number[] | null {
  let input = cleanHostname(address);
  if (net.isIP(input) !== 6) return null;

  const ipv4Match = input.match(/(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (ipv4Match) {
    const value = ipv4Number(ipv4Match[1]);
    if (value === null) return null;
    input =
      input.slice(0, -ipv4Match[1].length) +
      `${((value >>> 16) & 0xffff).toString(16)}:${(value & 0xffff).toString(16)}`;
  }

  const halves = input.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - left.length - right.length;
  if (missing < 0 || (halves.length === 1 && missing !== 0)) return null;
  const groups = [
    ...left,
    ...Array.from({ length: missing }, () => '0'),
    ...right,
  ];
  if (groups.length !== 8) return null;

  const bytes: number[] = [];
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/i.test(group)) return null;
    const value = Number.parseInt(group, 16);
    bytes.push((value >>> 8) & 0xff, value & 0xff);
  }
  return bytes;
}

function classifyIpv6(address: string): BrowserAddressClass {
  if (METADATA_IPV6.has(cleanHostname(address))) return 'metadata';
  const bytes = ipv6Bytes(address);
  if (!bytes) return 'reserved';
  const allZero = bytes.every((value) => value === 0);
  if (allZero) return 'unspecified';
  if (bytes.slice(0, 15).every((value) => value === 0) && bytes[15] === 1) {
    return 'loopback';
  }

  const isMappedV4 =
    bytes.slice(0, 10).every((value) => value === 0) &&
    bytes[10] === 0xff &&
    bytes[11] === 0xff;
  if (isMappedV4) {
    return classifyIpv4(bytes.slice(12).join('.'));
  }
  // Deprecated IPv4-compatible and RFC 6052 NAT64 forms can otherwise hide a
  // private/metadata IPv4 destination inside a syntactically public IPv6 URL.
  const isCompatibleV4 = bytes.slice(0, 12).every((value) => value === 0);
  const isWellKnownNat64 =
    bytes[0] === 0x00 &&
    bytes[1] === 0x64 &&
    bytes[2] === 0xff &&
    bytes[3] === 0x9b &&
    bytes.slice(4, 12).every((value) => value === 0);
  if (isCompatibleV4 || isWellKnownNat64) {
    return classifyIpv4(bytes.slice(12).join('.'));
  }
  // 6to4 embeds the routed IPv4 endpoint immediately after 2002::/16.
  if (bytes[0] === 0x20 && bytes[1] === 0x02) {
    const embedded = classifyIpv4(bytes.slice(2, 6).join('.'));
    if (embedded !== 'public') return embedded;
  }
  // Teredo and deprecated site-local space should never be browser targets in
  // this product; treating them as reserved avoids ambiguous tunnelling.
  if (
    (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0 && bytes[3] === 0) ||
    (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0xc0)
  ) {
    return 'reserved';
  }
  if ((bytes[0] & 0xfe) === 0xfc) return 'private';
  if (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80) return 'link-local';
  if (bytes[0] === 0xff) return 'multicast';
  if (
    bytes[0] === 0x20 &&
    bytes[1] === 0x01 &&
    bytes[2] === 0x0d &&
    bytes[3] === 0xb8
  ) {
    return 'documentation';
  }
  return 'public';
}

export function classifyBrowserAddress(address: string): BrowserAddressClass {
  const normalized = cleanHostname(address);
  if (net.isIP(normalized) === 4) return classifyIpv4(normalized);
  if (net.isIP(normalized) === 6) return classifyIpv6(normalized);
  return 'reserved';
}

function isOverrideablePrivate(value: BrowserAddressClass): boolean {
  return (
    value === 'loopback' ||
    value === 'private' ||
    value === 'carrier-grade-nat'
  );
}

export function browserAddressesMatchPrivatePins(
  addresses: readonly string[],
  classes: readonly BrowserAddressClass[],
  approvedPrivateAddresses?: ReadonlySet<string>,
): boolean {
  return addresses.every((address, index) => {
    const addressClass = classes[index];
    if (addressClass === 'public') return true;
    return (
      addressClass !== undefined &&
      isOverrideablePrivate(addressClass) &&
      approvedPrivateAddresses?.has(address) === true
    );
  });
}

function isForbidden(value: BrowserAddressClass): boolean {
  return value !== 'public' && !isOverrideablePrivate(value);
}

function defaultPort(protocol: string): string {
  return protocol === 'https:' || protocol === 'wss:' ? '443' : '80';
}

export function browserNetworkTargetKey(input: string | URL): string {
  const url = typeof input === 'string' ? new URL(input) : input;
  return `${cleanHostname(url.hostname)}:${url.port || defaultPort(url.protocol)}`;
}

export function normalizeBrowserUrl(
  raw: string,
  options: { allowAboutBlank?: boolean; requestProtocols?: boolean } = {},
): string {
  const input = raw.trim();
  if (options.allowAboutBlank !== false && input === 'about:blank') {
    return input;
  }
  if (!input) throw new Error('browser URL is empty');
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(input);
  const value = hasScheme ? input : `https://${input}`;
  const url = new URL(value);
  const allowed = options.requestProtocols
    ? new Set(['http:', 'https:', 'ws:', 'wss:'])
    : new Set(['http:', 'https:']);
  if (!allowed.has(url.protocol)) {
    throw new Error('browser panes only allow http:// and https:// URLs');
  }
  if (url.username || url.password) {
    throw new Error('URLs with embedded credentials are not allowed');
  }
  return url.toString();
}

/**
 * The one local path the browser trusts without a native confirmation: a
 * Nexus-owned preview of a built app. Agents are told to "run npm run dev" or
 * "open the file", and both are refused; the refusal must name what works
 * instead of leaving the agent to guess (P0-6). The policy itself is not
 * loosened — the preview is the trusted route.
 */
const LOCAL_PREVIEW_PATH =
  'build the app, serve the build folder with nexus_preview_start({dir}), ' +
  'open the returned URL with nexus_browser_open and check the breakpoints ' +
  'with nexus_browser_responsive';

export function browserBlockedTargetHint(
  kind: BrowserUrlBlockKind,
  rawUrl?: string,
): string | null {
  if (kind === 'private-network') {
    return `local dev servers and LAN hosts are not opened directly: ${LOCAL_PREVIEW_PATH}`;
  }
  if (kind === 'unsafe-scheme' && /^\s*file:/i.test(rawUrl ?? '')) {
    return `local files are not opened as file://: ${LOCAL_PREVIEW_PATH}`;
  }
  return null;
}

export const resolveBrowserHostname: BrowserAddressResolver = async (hostname) => {
  const records = await dns.promises.lookup(hostname, {
    all: true,
    verbatim: true,
  });
  return [...new Set(records.map((record) => record.address))];
};

function blocked(
  kind: BrowserUrlBlockKind,
  reason: string,
  url?: URL,
  addresses?: string[],
  classes?: BrowserAddressClass[],
): BrowserUrlBlocked {
  return {
    allowed: false,
    kind,
    reason,
    ...(url
      ? {
          normalizedUrl: url.toString(),
          targetKey: browserNetworkTargetKey(url),
        }
      : {}),
    ...(addresses ? { addresses } : {}),
    ...(classes ? { addressClasses: classes } : {}),
  };
}

export async function assessBrowserUrl(
  raw: string,
  options: BrowserUrlPolicyOptions = {},
): Promise<BrowserUrlDecision> {
  let normalized: string;
  try {
    normalized = normalizeBrowserUrl(raw, options);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'invalid browser URL';
    const kind: BrowserUrlBlockKind = message.includes('credentials')
      ? 'embedded-credentials'
      : message.includes('only allow')
        ? 'unsafe-scheme'
        : 'invalid-url';
    return blocked(kind, message);
  }

  if (normalized === 'about:blank') {
    return {
      allowed: true,
      normalizedUrl: normalized,
      targetKey: 'about:blank',
      addresses: [],
      addressClasses: [],
    };
  }

  const url = new URL(normalized);
  const hostname = cleanHostname(url.hostname);
  if (METADATA_HOSTS.has(hostname)) {
    return blocked(
      'forbidden-network',
      'cloud metadata endpoints are never allowed',
      url,
      [hostname],
      ['metadata'],
    );
  }

  const trustedPrivate = options.isTrustedPrivateUrl?.(url) === true;
  const allowPrivate = options.allowPrivateNetwork === true || trustedPrivate;
  const literalVersion = net.isIP(hostname);
  if (literalVersion !== 0) {
    const addressClass = classifyBrowserAddress(hostname);
    if (addressClass === 'public' || (allowPrivate && isOverrideablePrivate(addressClass))) {
      return {
        allowed: true,
        normalizedUrl: normalized,
        targetKey: browserNetworkTargetKey(url),
        addresses: [hostname],
        addressClasses: [addressClass],
      };
    }
    return blocked(
      isForbidden(addressClass) ? 'forbidden-network' : 'private-network',
      isForbidden(addressClass)
        ? `network class ${addressClass} is not allowed`
        : 'private-network access requires explicit confirmation',
      url,
      [hostname],
      [addressClass],
    );
  }

  const isPrivateHostname =
    hostname === 'localhost' ||
    PRIVATE_HOST_SUFFIXES.some((suffix) => hostname.endsWith(suffix));
  if (isPrivateHostname && !allowPrivate) {
    return blocked(
      'private-network',
      'private or local host access requires explicit confirmation',
      url,
      [hostname],
      ['private'],
    );
  }

  let addresses: string[];
  try {
    addresses = await (options.resolver ?? resolveBrowserHostname)(hostname);
  } catch {
    return blocked('dns-failure', 'hostname could not be resolved safely', url);
  }
  if (addresses.length === 0) {
    return blocked('dns-failure', 'hostname resolved to no addresses', url);
  }

  const classes = addresses.map(classifyBrowserAddress);
  if (classes.some(isForbidden)) {
    return blocked(
      'forbidden-network',
      'hostname resolved to a forbidden network address',
      url,
      addresses,
      classes,
    );
  }
  if (classes.some(isOverrideablePrivate) && !allowPrivate) {
    return blocked(
      'private-network',
      'hostname resolved to a private network address; confirmation required',
      url,
      addresses,
      classes,
    );
  }
  return {
    allowed: true,
    normalizedUrl: normalized,
    targetKey: browserNetworkTargetKey(url),
    addresses,
    addressClasses: classes,
  };
}

const SENSITIVE_QUERY_KEY =
  /(?:token|secret|password|passwd|api[_-]?key|access[_-]?key|auth|authorization|cookie|session|credential|code)/i;

/** A model-facing URL that never includes credentials or query values. */
export function redactBrowserUrl(raw: string): string {
  if (raw === 'about:blank') return raw;
  try {
    const url = new URL(raw);
    url.username = '';
    url.password = '';
    const keys = [...new Set([...url.searchParams.keys()])];
    url.search = '';
    for (const key of keys.slice(0, 32)) {
      url.searchParams.append(key, SENSITIVE_QUERY_KEY.test(key) ? '[REDACTED]' : '');
    }
    if (
      url.hash.length > 129 ||
      SENSITIVE_QUERY_KEY.test(url.hash) ||
      !/^#[#/a-z0-9._-]*$/i.test(url.hash)
    ) {
      url.hash = url.hash ? '#[REDACTED]' : '';
    }
    // The path can still carry a secret (magic-link / reset / share token);
    // redact just the pathname before it reaches the model or persisted
    // screenshot metadata (query values are already emptied above).
    url.pathname = redactVisibleSecrets(url.pathname);
    return url.toString();
  } catch {
    return '[invalid URL]';
  }
}
