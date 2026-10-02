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
  tag_name?: string;
  publishedAt?: string;
  published_at?: string;
  body?: string;
  isDraft?: boolean;
  draft?: boolean;
  isPrerelease?: boolean;
  prerelease?: boolean;
  assets?: Array<{
    name?: string;
    url?: string;
    browser_download_url?: string;
    browserDownloadUrl?: string;
  }>;
}

export interface ParsedRelease extends UpdateAvailableInfo {
  /** Nome exato do asset .zip da arquitetura atual (payload do Squirrel.Mac). */
  zipAsset: string;
  /**
   * URL pública direta do asset (browser_download_url) — presente quando o
   * release veio da API REST; permite download sem gh CLI (fallback público
   * para máquinas sem gh logado, ex.: instalações de terceiros).
   */
  zipDownloadUrl?: string;
}

const NOTES_MAX_CHARS = 600;
const STABLE_RELEASE_TAG_RE = /^v?\d+\.\d+\.\d+$/i;

export type MacUpdateArchitecture = 'arm64' | 'x64';

export function isMacUpdatePlatform(platform: string): platform is 'darwin' {
  return platform === 'darwin';
}

export function macUpdateArchitecture(arch: string): MacUpdateArchitecture | null {
  return arch === 'arm64' || arch === 'x64' ? arch : null;
}

function parseReleaseCandidate(
  json: GhReleaseJson,
  currentVersion: string,
  arch: MacUpdateArchitecture,
): ParsedRelease | null {
  if (
    json.draft === true ||
    json.isDraft === true ||
    json.prerelease === true ||
    json.isPrerelease === true
  ) {
    return null;
  }
  const tagValue = json.tagName ?? json.tag_name;
  const tag = typeof tagValue === 'string' ? tagValue.trim() : '';
  if (!STABLE_RELEASE_TAG_RE.test(tag)) return null;
  const version = tag.replace(/^v/i, '');
  if (cmpSemver(version, currentVersion) <= 0) return null;
  const zip = json.assets?.find(
    (asset) =>
      typeof asset.name === 'string' &&
      asset.name.endsWith(`darwin-${arch}-${version}.zip`),
  );
  if (!zip?.name) return null;
  const downloadUrlValue = zip.browser_download_url ?? zip.browserDownloadUrl;
  const zipDownloadUrl =
    typeof downloadUrlValue === 'string' && /^https:\/\//.test(downloadUrlValue)
      ? downloadUrlValue
      : undefined;
  const notes = typeof json.body === 'string' && json.body.trim()
    ? json.body.trim().slice(0, NOTES_MAX_CHARS)
    : undefined;
  const publishedAtValue = json.publishedAt ?? json.published_at;
  const publishedAt = typeof publishedAtValue === 'string'
    ? publishedAtValue
    : undefined;
  return {
    version,
    tag,
    zipAsset: zip.name,
    ...(zipDownloadUrl ? { zipDownloadUrl } : {}),
    ...(publishedAt ? { publishedAt } : {}),
    ...(notes ? { notes } : {}),
  };
}

/**
 * Interpreta um único release do `gh`, com o ZIP Squirrel da arquitetura
 * atual. null = mesma versão/mais velho, JSON inválido ou release sem payload
 * compatível. Nunca baixa um ZIP ARM em um Mac Intel (ou o inverso).
 */
export function parseGhRelease(
  raw: string,
  currentVersion: string,
  runtimeArch: string = process.arch,
  runtimePlatform: string = process.platform,
): ParsedRelease | null {
  if (!isMacUpdatePlatform(runtimePlatform)) return null;
  const arch = macUpdateArchitecture(runtimeArch);
  if (!arch) return null;
  let json: GhReleaseJson;
  try {
    json = JSON.parse(raw) as GhReleaseJson;
  } catch {
    return null;
  }
  if (!json || typeof json !== 'object' || Array.isArray(json)) return null;
  return parseReleaseCandidate(json, currentVersion, arch);
}

/**
 * Resposta de `gh api repos/<repo>/releases?per_page=100` → maior versão
 * estável que tenha o ZIP da arquitetura atual. A ordem da API e o marcador
 * "latest" não influenciam a decisão.
 */
export function parseGhReleases(
  raw: string,
  currentVersion: string,
  runtimeArch: string = process.arch,
  runtimePlatform: string = process.platform,
): ParsedRelease | null {
  if (!isMacUpdatePlatform(runtimePlatform)) return null;
  const arch = macUpdateArchitecture(runtimeArch);
  if (!arch) return null;
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(json)) return null;

  let best: ParsedRelease | null = null;
  for (const value of json) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const candidate = parseReleaseCandidate(
      value as GhReleaseJson,
      currentVersion,
      arch,
    );
    if (candidate && (!best || cmpSemver(candidate.version, best.version) > 0)) {
      best = candidate;
    }
  }
  return best;
}

/** Linux: atualização manual. O comando é o mesmo da instalação no site. */
export const LINUX_UPDATE_COMMAND = 'curl -fsSL https://nexuside.app/install.sh | sh';
export const LINUX_DOWNLOAD_URL = 'https://nexuside.app/#download';

/** Os três pacotes que o canal Linux x64 publica juntos numa versão. */
function linuxAssetNames(version: string): string[] {
  return [
    `nexus-ide_${version}_amd64.deb`,
    `nexus-ide-${version}-1.x86_64.rpm`,
    `NexusIDE-linux-x64-${version}.zip`,
  ];
}

/**
 * Maior versão estável, acima da atual, que traz os TRÊS pacotes Linux — o
 * mesmo crivo do catálogo do site e do `install.sh`. Release só de Windows ou
 * de macOS não conta (o canal Linux é independente), e uma publicação ainda
 * pela metade também não: o aviso só aparece quando o comando de atualização
 * realmente entrega aquela versão.
 */
export function parseLinuxReleases(
  raw: string,
  currentVersion: string,
  runtimeArch: string = process.arch,
): UpdateAvailableInfo | null {
  if (runtimeArch !== 'x64') return null;
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(json)) return null;
  let best: UpdateAvailableInfo | null = null;
  for (const value of json) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const release = value as GhReleaseJson;
    if (
      release.draft === true ||
      release.isDraft === true ||
      release.prerelease === true ||
      release.isPrerelease === true
    ) {
      continue;
    }
    const tagValue = release.tagName ?? release.tag_name;
    const tag = typeof tagValue === 'string' ? tagValue.trim() : '';
    if (!STABLE_RELEASE_TAG_RE.test(tag)) continue;
    const version = tag.replace(/^v/i, '');
    if (cmpSemver(version, currentVersion) <= 0) continue;
    const names = new Set(
      (release.assets ?? []).map((asset) => asset.name).filter((name) => typeof name === 'string'),
    );
    if (!linuxAssetNames(version).every((name) => names.has(name))) continue;
    if (best && cmpSemver(version, best.version) <= 0) continue;
    const notes = typeof release.body === 'string' && release.body.trim()
      ? release.body.trim().slice(0, NOTES_MAX_CHARS)
      : undefined;
    const publishedAtValue = release.publishedAt ?? release.published_at;
    best = {
      version,
      tag,
      ...(typeof publishedAtValue === 'string' ? { publishedAt: publishedAtValue } : {}),
      ...(notes ? { notes } : {}),
    };
  }
  return best;
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
