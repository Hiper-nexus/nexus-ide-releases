/**
 * Import de pets da galeria petdex (codex-pets.net / petdex.dev, código MIT).
 * Não há API pública de listagem: cada pet expõe /install/<slug>, um shell
 * script determinístico com as URLs dos assets no R2 (protegidos por
 * hotlink — exigem Referer da galeria). Parseamos o script (nunca o
 * executamos) e baixamos só o spritesheet, com teto de tamanho e de MIME.
 * A arte é licenciada por submissão: o import é escolha explícita do usuário.
 */

import { checkNetworkTarget, type HostLookup } from '../net/ssrf-guard';

/** petdex.dev primeiro: o codex-pets.net responde 404 nas rotas /install. */
export const GALLERY_BASES = [
  'https://petdex.dev',
  'https://codex-pets.net',
] as const;

const GALLERY_REFERER = 'https://petdex.dev/';
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const SCRIPT_MAX_BYTES = 64_000;
/**
 * Teto de rede. O renderer reduz sheets acima do limite das prefs para uma
 * malha equivalente antes de persistir; manter este limite separado evita
 * rejeitar boa parte do catálogo petdex sem aceitar downloads arbitrários.
 */
const SHEET_MAX_BYTES = 12_000_000;
const SHEET_MIME_RE = /^image\/(png|webp|jpeg)(;|$)/i;

export interface GalleryPet {
  name: string;
  mime: 'image/png' | 'image/webp';
  spritesheetUrl: string;
}

export interface GalleryImportResult {
  ok: boolean;
  name?: string;
  dataUrl?: string;
  error?: string;
}

/**
 * Aceita o slug puro, a URL da página (…/pets/<slug>) ou a URL de install
 * (…/install/<slug>) de qualquer domínio da galeria. Devolve null para
 * qualquer coisa fora desse formato.
 */
export function extractPetSlug(input: string): string | null {
  const trimmed = input.trim().toLowerCase();
  if (SLUG_RE.test(trimmed)) return trimmed;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  const galleryHosts = new Set(
    GALLERY_BASES.map((base) => new URL(base).host),
  );
  if (!galleryHosts.has(url.host)) return null;
  const PATH_RE = /^(?:\/[a-z-]{2,5})?\/(?:pets|install)\/([a-z0-9][a-z0-9-]{0,62})\/?$/;
  const match = url.pathname.match(PATH_RE);
  if (match) return match[1];
  // Frontends com hash-routing (codex-pets.net usa /#/pets/<slug>).
  const hashMatch = url.hash.replace(/^#/, '').match(PATH_RE);
  return hashMatch ? hashMatch[1] : null;
}

export interface GalleryCatalogEntry {
  slug: string;
  label: string;
}

const CATALOG_MAX_BYTES = 10_000_000;
const CATALOG_MAX_ITEMS = 400;
const CATALOG_TTL_MS = 10 * 60 * 1000;
let catalogCache: { at: number; items: GalleryCatalogEntry[] } | null = null;

/** "aurelion-sol-2" → "Aurelion Sol 2"; sufixos hex de dedupe caem fora. */
function labelFromSlug(slug: string): string {
  return slug
    .replace(/-[0-9a-f]{12}$/, '')
    .split('-')
    .map((part) => (part ? part[0].toUpperCase() + part.slice(1) : part))
    .join(' ');
}

/**
 * Catálogo AO VIVO da galeria via sitemap (não embarcamos arte nem lista
 * curada: a galeria é da comunidade e os personagens podem ter direitos de
 * terceiros — o app só mostra o que o site publica, como um navegador).
 */
export async function fetchGalleryCatalog(
  fetchImpl: typeof fetch = fetch,
  now: number = Date.now(),
): Promise<{ ok: boolean; items?: GalleryCatalogEntry[]; error?: string }> {
  if (catalogCache && now - catalogCache.at < CATALOG_TTL_MS) {
    return { ok: true, items: catalogCache.items };
  }
  try {
    const res = await fetchImpl(`${GALLERY_BASES[0]}/sitemap.xml`, {
      redirect: 'follow',
      headers: { accept: 'application/xml,text/xml' },
    });
    if (!res.ok) {
      return { ok: false, error: `Galeria indisponível (${res.status}).` };
    }
    const body = await readCapped(res, CATALOG_MAX_BYTES);
    if (!body) return { ok: false, error: 'Sitemap da galeria grande demais.' };
    const xml = body.toString('utf8');
    const seen = new Set<string>();
    const items: GalleryCatalogEntry[] = [];
    const re = new RegExp(
      `<loc>${GALLERY_BASES[0]}/pets/([a-z0-9][a-z0-9-]{0,62})</loc>`,
      'g',
    );
    for (const match of xml.matchAll(re)) {
      const slug = match[1];
      if (seen.has(slug)) continue;
      seen.add(slug);
      items.push({ slug, label: labelFromSlug(slug) });
      if (items.length >= CATALOG_MAX_ITEMS) break;
    }
    if (items.length === 0) {
      return { ok: false, error: 'A galeria não listou nenhum pet.' };
    }
    items.sort((a, b) => a.label.localeCompare(b.label, 'pt-BR'));
    catalogCache = { at: now, items };
    return { ok: true, items };
  } catch (err) {
    return {
      ok: false,
      error: `Sem conexão com a galeria (${err instanceof Error ? err.message : 'erro de rede'}).`,
    };
  }
}

export function __resetGalleryCatalogCacheForTests(): void {
  catalogCache = null;
}

/**
 * Extrai displayName + URL do spritesheet do script POSIX de install.
 * O template é determinístico (install-script-render.ts do petdex):
 *   DISPLAY_NAME='…'
 *   curl … -o "$PET_DIR/spritesheet.webp" 'https://…'
 */
export function parseInstallScript(script: string): GalleryPet | null {
  const nameMatch = script.match(/^DISPLAY_NAME='((?:[^']|'\\'')*)'$/m);
  const sheetMatch = script.match(
    /-o "\$PET_DIR\/spritesheet\.(webp|png)" '((?:[^']|'\\'')*)'/,
  );
  if (!sheetMatch) return null;
  const unquote = (value: string) => value.replace(/'\\''/g, "'");
  const spritesheetUrl = unquote(sheetMatch[2]);
  let parsed: URL;
  try {
    parsed = new URL(spritesheetUrl);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:') return null;
  return {
    name: nameMatch ? unquote(nameMatch[1]) : 'Pet da galeria',
    mime: sheetMatch[1] === 'png' ? 'image/png' : 'image/webp',
    spritesheetUrl,
  };
}

async function readCapped(
  response: Response,
  maxBytes: number,
): Promise<Buffer | null> {
  const declared = Number(response.headers.get('content-length') ?? '0');
  if (declared > maxBytes) return null;
  const buffer = Buffer.from(await response.arrayBuffer());
  return buffer.byteLength > maxBytes ? null : buffer;
}

/**
 * Instância self-host do codex-pet-share (galeria própria/oficial): URL
 * https de QUALQUER host fora das bases petdex, no formato /pets/<id>.
 * Contrato do worker: GET /api/pets/<id> (manifest JSON) e
 * GET /api/pets/<id>/spritesheet (asset webp direto).
 */
export function extractPetShareRef(
  input: string,
): { origin: string; id: string } | null {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  const galleryHosts = new Set(GALLERY_BASES.map((base) => new URL(base).host));
  if (galleryHosts.has(url.host)) return null;
  const path = url.hash.startsWith('#/') ? url.hash.slice(1) : url.pathname;
  const match = path.match(/^\/pets\/([A-Za-z0-9][A-Za-z0-9_-]{0,127})\/?$/);
  return match ? { origin: url.origin, id: match[1] } : null;
}

async function importPetShareInstance(
  ref: { origin: string; id: string },
  fetchImpl: typeof fetch,
  lookupImpl?: HostLookup,
): Promise<GalleryImportResult> {
  // SSRF guard (M6): the origin host is renderer-controlled and fetched by the
  // main process. Reject metadata/link-local/reserved destinations before any
  // request, and forbid redirects (a 302 → 169.254.169.254 would otherwise
  // bounce the fetch into the cloud-metadata service).
  //
  // Residual: `fetch` below re-resolves the hostname, so a TOCTOU DNS-rebinding
  // window remains (guard sees a public IP, fetch gets a private one). The
  // direct-literal and redirect vectors are closed; fully pinning would need a
  // custom undici dispatcher that connects by the resolved IP while preserving
  // the TLS SNI/servername — deferred (accepted residual).
  const guard = await checkNetworkTarget(
    new URL(ref.origin).hostname,
    lookupImpl,
  );
  if (!guard.ok) {
    return { ok: false, error: 'Instância bloqueada por política de rede.' };
  }
  let name = ref.id;
  try {
    const res = await fetchImpl(`${ref.origin}/api/pets/${ref.id}`, {
      redirect: 'error',
      headers: { accept: 'application/json' },
    });
    if (res.ok) {
      const body = await readCapped(res, 64_000);
      if (body) {
        const manifest = JSON.parse(body.toString('utf8')) as Record<
          string,
          unknown
        >;
        const candidate = manifest.displayName ?? manifest.name;
        if (typeof candidate === 'string' && candidate.trim()) {
          name = candidate.trim();
        }
      }
    }
  } catch {
    // manifest é best-effort: o asset direto decide o import
  }
  try {
    const res = await fetchImpl(`${ref.origin}/api/pets/${ref.id}/spritesheet`, {
      redirect: 'error',
      headers: { referer: `${ref.origin}/` },
    });
    if (!res.ok) {
      return {
        ok: false,
        error: `A instância respondeu ${res.status} para o spritesheet.`,
      };
    }
    const contentType = res.headers.get('content-type') ?? 'image/webp';
    if (!SHEET_MIME_RE.test(contentType)) {
      return { ok: false, error: 'O asset da instância não é uma imagem suportada.' };
    }
    const sheet = await readCapped(res, SHEET_MAX_BYTES);
    if (!sheet) {
      return { ok: false, error: 'Spritesheet grande demais (limite 12 MB).' };
    }
    const mime = SHEET_MIME_RE.exec(contentType)?.[1] ?? 'webp';
    return {
      ok: true,
      name,
      dataUrl: `data:image/${mime === 'jpeg' ? 'jpeg' : mime};base64,${sheet.toString('base64')}`,
    };
  } catch (err) {
    return {
      ok: false,
      error: `Sem conexão com a instância (${err instanceof Error ? err.message : 'erro de rede'}).`,
    };
  }
}

/**
 * Fluxo completo: slug → script de install → download do sheet → data URL.
 * `fetchImpl` é injetável para teste; o default é o fetch do Node no main.
 */
export async function importGalleryPet(
  input: string,
  fetchImpl: typeof fetch = fetch,
  lookupImpl?: HostLookup,
): Promise<GalleryImportResult> {
  // Instância própria (codex-pet-share self-host) tem prioridade quando a
  // URL não é das bases comunitárias.
  const shareRef = extractPetShareRef(input);
  if (shareRef) return importPetShareInstance(shareRef, fetchImpl, lookupImpl);

  const slug = extractPetSlug(input);
  if (!slug) {
    return { ok: false, error: 'Informe o slug ou a URL do pet na galeria.' };
  }

  let script: string | null = null;
  for (const base of GALLERY_BASES) {
    try {
      const res = await fetchImpl(`${base}/install/${slug}?platform=posix`, {
        redirect: 'follow',
        headers: { accept: 'text/plain' },
      });
      if (!res.ok) continue;
      const body = await readCapped(res, SCRIPT_MAX_BYTES);
      if (body) {
        script = body.toString('utf8');
        break;
      }
    } catch {
      // tenta a próxima base
    }
  }
  if (!script) {
    return { ok: false, error: `Pet "${slug}" não encontrado na galeria.` };
  }

  const pet = parseInstallScript(script);
  if (!pet) {
    return {
      ok: false,
      error: 'A galeria respondeu num formato que não reconheço.',
    };
  }

  try {
    const res = await fetchImpl(pet.spritesheetUrl, {
      redirect: 'follow',
      // O R2 da galeria exige o Referer dela (hotlink protection).
      headers: { referer: GALLERY_REFERER },
    });
    if (!res.ok) {
      return { ok: false, error: `Download do spritesheet falhou (${res.status}).` };
    }
    const contentType = res.headers.get('content-type') ?? pet.mime;
    if (!SHEET_MIME_RE.test(contentType)) {
      return { ok: false, error: 'O asset da galeria não é uma imagem suportada.' };
    }
    const sheet = await readCapped(res, SHEET_MAX_BYTES);
    if (!sheet) {
      return { ok: false, error: 'Spritesheet grande demais (limite 12 MB).' };
    }
    const mime = SHEET_MIME_RE.exec(contentType)?.[1] ?? 'webp';
    return {
      ok: true,
      name: pet.name,
      dataUrl: `data:image/${mime === 'jpeg' ? 'jpeg' : mime};base64,${sheet.toString('base64')}`,
    };
  } catch (err) {
    return {
      ok: false,
      error: `Sem conexão com a galeria (${err instanceof Error ? err.message : 'erro de rede'}).`,
    };
  }
}
