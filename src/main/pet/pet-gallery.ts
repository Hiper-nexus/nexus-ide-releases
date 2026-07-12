/**
 * Import de pets da galeria petdex (codex-pets.net / petdex.dev, código MIT).
 * Não há API pública de listagem: cada pet expõe /install/<slug>, um shell
 * script determinístico com as URLs dos assets no R2 (protegidos por
 * hotlink — exigem Referer da galeria). Parseamos o script (nunca o
 * executamos) e baixamos só o spritesheet, com teto de tamanho e de MIME.
 * A arte é licenciada por submissão: o import é escolha explícita do usuário.
 */

export const GALLERY_BASES = [
  'https://codex-pets.net',
  'https://petdex.dev',
] as const;

const GALLERY_REFERER = 'https://petdex.dev/';
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const SCRIPT_MAX_BYTES = 64_000;
/** Raw ≤ ~2,6 MB para o base64 caber no teto das prefs (3,5 M chars). */
const SHEET_MAX_BYTES = 2_600_000;
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
  const match = url.pathname.match(
    /^(?:\/[a-z-]{2,5})?\/(?:pets|install)\/([a-z0-9][a-z0-9-]{0,62})\/?$/,
  );
  return match ? match[1] : null;
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
 * Fluxo completo: slug → script de install → download do sheet → data URL.
 * `fetchImpl` é injetável para teste; o default é o fetch do Node no main.
 */
export async function importGalleryPet(
  input: string,
  fetchImpl: typeof fetch = fetch,
): Promise<GalleryImportResult> {
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
      return { ok: false, error: 'Spritesheet grande demais (limite ~2,5 MB).' };
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
