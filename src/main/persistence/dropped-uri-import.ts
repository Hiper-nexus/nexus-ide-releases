import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dns from 'node:dns';
import net from 'node:net';
import {
  DROPPED_ATTACHMENT_MAX_BYTES,
  importWorkspaceMissionAttachmentBytes,
  type SaveDroppedFileOptions,
  type SaveDroppedFileResult,
} from './dropped-files';

/**
 * Drop que chegou sem `File`.
 *
 * Apps nativos (WhatsApp, Fotos) põem uma PROMESSA de arquivo no pasteboard
 * que o Chromium nem sempre materializa, ou entregam só um `text/uri-list`
 * com `file://…` ou `https://…`. Aqui o main lê o arquivo local ou baixa o
 * link e estagia os bytes em mission-context — o mesmo destino do drop do
 * Finder — devolvendo o caminho relativo à raiz do workspace.
 *
 * Conteúdo baixado é dado NÃO confiável: são só bytes para o disco, nunca
 * interpretados nem logados. As mensagens são autorais em PT-BR porque o
 * toast do renderer descarta o que parece diagnóstico interno.
 */

export const DROPPED_URL_TIMEOUT_MS = 20_000;
const LIMIT_LABEL = '14 MB';
const SCHEME_HINT =
  'Só arquivos locais (file://) e links http(s) podem ser soltos aqui.';
const NOFOLLOW_FLAG = fs.constants.O_NOFOLLOW ?? 0;

export type ParsedDroppedUri =
  | { readonly kind: 'file'; readonly path: string }
  | { readonly kind: 'url'; readonly url: URL }
  | { readonly kind: 'rejected'; readonly error: string };

export type HostLookup = (
  host: string,
) => Promise<ReadonlyArray<{ readonly address: string; readonly family: number }>>;

export interface ImportDroppedUriOptions extends SaveDroppedFileOptions {
  /** Injetável nos testes; produção usa o fetch global do main. */
  readonly fetch?: typeof globalThis.fetch;
  readonly timeoutMs?: number;
  readonly now?: () => number;
  /** Resolução de nome injetável; produção usa `dns.promises.lookup`. */
  readonly lookup?: HostLookup;
}

/** Teto de saltos de redirecionamento; cada salto é revalidado. */
export const DROPPED_URL_MAX_REDIRECTS = 5;

const LOCAL_TARGET_MESSAGE =
  'Endereço local ou de rede privada não é baixado. Salve o arquivo e arraste do Finder.';

function ipv4Octets(address: string): number[] | null {
  const parts = address.split('.');
  if (parts.length !== 4) return null;
  const octets = parts.map((part) => (/^\d{1,3}$/u.test(part) ? Number(part) : NaN));
  return octets.every((octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255)
    ? octets
    : null;
}

function isBlockedIpv4(address: string): boolean {
  const o = ipv4Octets(address);
  if (!o) return true;
  const [a, b] = o as [number, number, number, number];
  return (
    a === 0 || // 0.0.0.0/8 — não especificado
    a === 10 || // 10/8
    a === 127 || // loopback
    (a === 100 && b >= 64 && b <= 127) || // 100.64/10 — CGNAT
    (a === 169 && b === 254) || // link-local + metadata de nuvem
    (a === 172 && b >= 16 && b <= 31) || // 172.16/12
    (a === 192 && b === 168) || // 192.168/16
    a >= 224 // multicast e reservado
  );
}

/**
 * Loopback, privado, link-local, único-local, não especificado e IPv4 mapeado
 * em IPv6 — os alvos clássicos de SSRF num laptop (porta CDP, MCP do próprio
 * Nexus, painel do roteador, metadata de nuvem). Um link arrastado é gesto do
 * operador, mas o conteúdo baixado vira arquivo que o agente lê.
 */
export function isBlockedAddress(address: string): boolean {
  const trimmed = address.trim().replace(/^\[|\]$/gu, '');
  const family = net.isIP(trimmed);
  if (family === 4) return isBlockedIpv4(trimmed);
  if (family !== 6) return true;
  const lower = trimmed.toLowerCase();
  const zoneless = lower.replace(/%.*$/u, '');
  if (zoneless === '::' || zoneless === '::1') return true;
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/u.exec(zoneless);
  if (mapped) return isBlockedIpv4(mapped[1]!);
  const firstHextet = zoneless.split(':')[0] ?? '';
  const value = firstHextet === '' ? 0 : Number.parseInt(firstHextet, 16);
  if (!Number.isFinite(value)) return true;
  if ((value & 0xfe00) === 0xfc00) return true; // fc00::/7 único-local
  if ((value & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((value & 0xff00) === 0xff00) return true; // multicast
  return false;
}

const defaultLookup: HostLookup = (host) =>
  dns.promises.lookup(host, { all: true, verbatim: true });

/** `null` = pode buscar; string = motivo da recusa (já em PT-BR). */
async function refuseNonPublicTarget(
  url: URL,
  lookup: HostLookup,
): Promise<string | null> {
  const host = url.hostname.replace(/^\[|\]$/gu, '');
  if (host === '' || host === 'localhost' || host.endsWith('.localhost')) {
    return LOCAL_TARGET_MESSAGE;
  }
  if (net.isIP(host)) {
    return isBlockedAddress(host) ? LOCAL_TARGET_MESSAGE : null;
  }
  let resolved: ReadonlyArray<{ readonly address: string }>;
  try {
    resolved = await lookup(host);
  } catch {
    return `Não foi possível resolver ${host}.`;
  }
  if (resolved.length === 0) return `Não foi possível resolver ${host}.`;
  return resolved.some((entry) => isBlockedAddress(entry.address))
    ? LOCAL_TARGET_MESSAGE
    : null;
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

type LoadedBytes =
  | { readonly ok: true; readonly name: string; readonly bytes: Buffer }
  | { readonly ok: false; readonly error: string };

function isWebUrl(url: URL): boolean {
  return url.protocol === 'http:' || url.protocol === 'https:';
}

export function parseDroppedUri(uri: string): ParsedDroppedUri {
  let parsed: URL;
  try {
    parsed = new URL(uri.trim());
  } catch {
    return { kind: 'rejected', error: `Endereço inválido. ${SCHEME_HINT}` };
  }
  if (parsed.protocol === 'file:') {
    try {
      return { kind: 'file', path: fileURLToPath(parsed) };
    } catch {
      return {
        kind: 'rejected',
        error: `Endereço de arquivo inválido. ${SCHEME_HINT}`,
      };
    }
  }
  if (isWebUrl(parsed)) return { kind: 'url', url: parsed };
  return {
    kind: 'rejected',
    error: `Esquema "${parsed.protocol}" não é aceito. ${SCHEME_HINT}`,
  };
}

function tooLargeMessage(name: string): string {
  return `"${name}" excede o limite de ${LIMIT_LABEL} por arquivo.`;
}

function notRegularMessage(name: string): string {
  return `"${name}" não é um arquivo comum (pasta, link ou dispositivo).`;
}

/**
 * Regra mínima: caminho absoluto, `realpath` resolvido, arquivo regular e
 * dentro do teto. Sem seguir para diretórios nem dispositivos.
 */
function readLocalFile(requested: string): LoadedBytes {
  const name = path.basename(requested) || 'arquivo';
  if (!path.isAbsolute(requested)) {
    return { ok: false, error: `Caminho precisa ser absoluto: "${name}".` };
  }
  let real: string;
  try {
    real = fs.realpathSync(requested);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return { ok: false, error: `Arquivo não encontrado: "${name}".` };
    }
    return { ok: false, error: `Não foi possível abrir "${name}".` };
  }
  let fd: number | null = null;
  try {
    const before = fs.lstatSync(real);
    if (!before.isFile()) return { ok: false, error: notRegularMessage(name) };
    if (before.size > DROPPED_ATTACHMENT_MAX_BYTES) {
      return { ok: false, error: tooLargeMessage(name) };
    }
    fd = fs.openSync(real, fs.constants.O_RDONLY | NOFOLLOW_FLAG);
    const opened = fs.fstatSync(fd);
    if (!opened.isFile()) return { ok: false, error: notRegularMessage(name) };
    if (opened.size > DROPPED_ATTACHMENT_MAX_BYTES) {
      return { ok: false, error: tooLargeMessage(name) };
    }
    const bytes = fs.readFileSync(fd);
    if (bytes.length > DROPPED_ATTACHMENT_MAX_BYTES) {
      return { ok: false, error: tooLargeMessage(name) };
    }
    return { ok: true, name, bytes };
  } catch {
    return { ok: false, error: `Não foi possível ler "${name}".` };
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

function cleanFileName(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const leaf = raw.trim().split(/[\\/]/).pop() ?? '';
  const cleaned = leaf.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (cleaned === '' || cleaned === '.' || cleaned === '..') return null;
  return cleaned;
}

function nameFromContentDisposition(header: string | null): string | null {
  if (!header) return null;
  const extended = /filename\*\s*=\s*(?:utf-8|iso-8859-1)?'[^']*'([^;]+)/i.exec(
    header,
  );
  if (extended?.[1]) {
    try {
      const name = cleanFileName(decodeURIComponent(extended[1].trim()));
      if (name) return name;
    } catch {
      // Escape inválido no filename*: cai no filename= simples.
    }
  }
  const quoted = /filename\s*=\s*"((?:[^"\\]|\\.)*)"/i.exec(header);
  if (quoted?.[1] !== undefined) {
    return cleanFileName(quoted[1].replace(/\\(.)/g, '$1'));
  }
  const bare = /filename\s*=\s*([^;]+)/i.exec(header);
  return cleanFileName(bare?.[1]);
}

function nameFromUrlPath(url: URL): string | null {
  const segment = url.pathname.split('/').filter((part) => part !== '').pop();
  if (!segment) return null;
  let decoded = segment;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    // Segmento com escape inválido: fica cru, o estágio sanitiza.
  }
  return cleanFileName(decoded);
}

const EXTENSION_BY_MIME: Readonly<Record<string, string>> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'image/svg+xml': 'svg',
  'application/pdf': 'pdf',
  'application/json': 'json',
  'application/zip': 'zip',
  'text/plain': 'txt',
  'text/html': 'html',
  'text/csv': 'csv',
  'text/markdown': 'md',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/ogg': 'ogg',
  'audio/wav': 'wav',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/webm': 'webm',
};

function fallbackDownloadName(contentType: string | null, now: number): string {
  const mime = (contentType ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  const extension = EXTENSION_BY_MIME[mime] ?? 'bin';
  const stamp = new Date(now).toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return `download-${stamp}.${extension}`;
}

/** Content-Disposition → último segmento do caminho → `download-<carimbo>.<ext>`. */
export function downloadedFileName(
  contentDisposition: string | null,
  url: URL,
  contentType: string | null,
  now: number,
): string {
  return (
    nameFromContentDisposition(contentDisposition) ??
    nameFromUrlPath(url) ??
    fallbackDownloadName(contentType, now)
  );
}

function finalUrlOf(candidate: string | undefined, requested: URL): URL | null {
  if (!candidate) return requested;
  try {
    return new URL(candidate, requested);
  } catch {
    return null;
  }
}

async function discardBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Corpo já fechado; nada a liberar.
  }
}

/** Lê o corpo em streaming e desiste (cancelando) assim que passar do teto. */
async function readBodyCapped(
  body: ReadableStream<Uint8Array>,
  maxBytes: number,
): Promise<Buffer | null> {
  const reader = body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
    }
    return Buffer.concat(chunks);
  } finally {
    reader.releaseLock();
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function downloadUrl(
  url: URL,
  options: ImportDroppedUriOptions,
): Promise<LoadedBytes> {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DROPPED_URL_TIMEOUT_MS;
  const controller = new AbortController();
  let timedOut = false;
  const deadline = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const lookup = options.lookup ?? defaultLookup;
  try {
    // Redirecionamento MANUAL: cada salto é revalidado (esquema http(s) e
    // alvo público) e o teto evita cadeia infinita. `follow` deixaria um
    // Location apontar para 127.0.0.1 sem ninguém olhar.
    let finalUrl = url;
    let response: Response | null = null;
    for (let hop = 0; hop <= DROPPED_URL_MAX_REDIRECTS; hop += 1) {
      if (!isWebUrl(finalUrl)) {
        return {
          ok: false,
          error: 'O link redirecionou para fora de http(s); download recusado.',
        };
      }
      const refusal = await refuseNonPublicTarget(finalUrl, lookup);
      if (refusal) return { ok: false, error: refusal };
      const hopResponse = await fetchImpl(finalUrl.href, {
        signal: controller.signal,
        redirect: 'manual',
        headers: { 'user-agent': 'NexusIDE-drop' },
      });
      if (!isRedirect(hopResponse.status)) {
        response = hopResponse;
        break;
      }
      const location = hopResponse.headers.get('location');
      await discardBody(hopResponse);
      if (!location) {
        return { ok: false, error: `Download falhou: HTTP ${hopResponse.status} sem destino.` };
      }
      const next = finalUrlOf(location, finalUrl);
      if (!next) {
        return { ok: false, error: 'O link redirecionou para um endereço inválido.' };
      }
      finalUrl = next;
    }
    if (!response) {
      return {
        ok: false,
        error: `O link redirecionou mais de ${DROPPED_URL_MAX_REDIRECTS} vezes; download recusado.`,
      };
    }
    if (!response.ok) {
      await discardBody(response);
      return { ok: false, error: `Download falhou: HTTP ${response.status}.` };
    }
    const declared = Number(response.headers.get('content-length') ?? '');
    if (Number.isFinite(declared) && declared > DROPPED_ATTACHMENT_MAX_BYTES) {
      await discardBody(response);
      return {
        ok: false,
        error: `O link excede o limite de ${LIMIT_LABEL} por arquivo.`,
      };
    }
    if (!response.body) {
      return { ok: false, error: 'Download veio sem conteúdo.' };
    }
    const bytes = await readBodyCapped(response.body, DROPPED_ATTACHMENT_MAX_BYTES);
    if (!bytes) {
      return {
        ok: false,
        error: `O link excede o limite de ${LIMIT_LABEL} por arquivo.`,
      };
    }
    const name = downloadedFileName(
      response.headers.get('content-disposition'),
      finalUrl,
      response.headers.get('content-type'),
      options.now?.() ?? Date.now(),
    );
    return { ok: true, name, bytes };
  } catch (error) {
    if (timedOut) {
      return {
        ok: false,
        error: `Download excedeu ${Math.round(timeoutMs / 1000)} s. Salve o arquivo e arraste do Finder.`,
      };
    }
    return { ok: false, error: `Download falhou: ${describeError(error)}` };
  } finally {
    clearTimeout(deadline);
  }
}

/**
 * Estagia em mission-context o que um drop sem `File` apontou: lê o
 * `file://` local ou baixa o `http(s)://`. Qualquer outro esquema é recusado
 * antes de tocar disco ou rede.
 */
export async function importDroppedUri(
  workspaceRoot: string,
  uri: string,
  options: ImportDroppedUriOptions = {},
): Promise<SaveDroppedFileResult> {
  const parsed = parseDroppedUri(uri);
  if (parsed.kind === 'rejected') return { ok: false, error: parsed.error };
  const loaded =
    parsed.kind === 'file'
      ? readLocalFile(parsed.path)
      : await downloadUrl(parsed.url, options);
  if (!loaded.ok) return { ok: false, error: loaded.error };
  return importWorkspaceMissionAttachmentBytes(
    workspaceRoot,
    loaded.name,
    loaded.bytes,
    options,
  );
}
