import type { UpdateAvailableInfo } from '../shared/update-ipc';

/**
 * Fonte de updates via `gh` CLI — o repo é PRIVADO, então o feed público
 * (update.electronjs.org) não serve e um token embutido no app vazaria. O
 * `gh` autenticado da máquina resolve os dois problemas: checa o último
 * release e baixa o asset com as credenciais do usuário. Helpers puros aqui;
 * subprocesso/HTTP ficam no updater.
 */

/** Compara versões semver simples ("1.2.3", tolera prefixo v). >0 = a > b. */
export function cmpSemver(a: string, b: string): number {
  const parse = (v: string) =>
    v
      .trim()
      .replace(/^v/i, '')
      .split('.')
      .map((n) => Number.parseInt(n, 10) || 0);
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

interface GhReleaseJson {
  tagName?: string;
  publishedAt?: string;
  body?: string;
  assets?: Array<{ name?: string; url?: string }>;
}

export interface ParsedRelease extends UpdateAvailableInfo {
  /** Nome exato do asset .zip darwin-arm64 (payload do Squirrel.Mac). */
  zipAsset: string;
}

const NOTES_MAX_CHARS = 600;

/**
 * `gh release view --json tagName,publishedAt,assets,body` → release mais
 * novo que a versão atual, com o zip do Squirrel. null = sem update (mesma
 * versão ou mais velho), JSON inválido ou release sem o zip darwin-arm64.
 */
export function parseGhRelease(
  raw: string,
  currentVersion: string,
): ParsedRelease | null {
  let json: GhReleaseJson;
  try {
    json = JSON.parse(raw) as GhReleaseJson;
  } catch {
    return null;
  }
  const tag = json.tagName?.trim();
  if (!tag) return null;
  const version = tag.replace(/^v/i, '');
  if (cmpSemver(version, currentVersion) <= 0) return null;
  const zip = json.assets?.find(
    (a) =>
      typeof a.name === 'string' &&
      a.name.includes('darwin-arm64') &&
      a.name.endsWith('.zip'),
  );
  if (!zip?.name) return null;
  const notes = json.body?.trim()
    ? json.body.trim().slice(0, NOTES_MAX_CHARS)
    : undefined;
  return {
    version,
    tag,
    zipAsset: zip.name,
    publishedAt: json.publishedAt,
    ...(notes ? { notes } : {}),
  };
}

/**
 * JSON de feed do Squirrel.Mac apontando para o zip (servido em localhost
 * depois que o gh baixou — o Squirrel valida assinatura e faz o swap seguro).
 */
export function buildSquirrelFeed(release: ParsedRelease, zipUrl: string): string {
  return JSON.stringify({
    url: zipUrl,
    name: release.tag,
    ...(release.notes ? { notes: release.notes } : {}),
    ...(release.publishedAt ? { pub_date: release.publishedAt } : {}),
  });
}
