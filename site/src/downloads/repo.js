/**
 * Repositório apt e dnf do Linux, servido pelo próprio Worker do site SEM hospedar nenhum arquivo: cada
 * endereço de `/apt/...` e `/rpm/...` redireciona para o arquivo de mesmo papel na release Linux mais nova do
 * repositório público de releases. Os metadados (Packages, Release, InRelease, repodata) são gerados e ASSINADOS
 * no host de quem publica (scripts/build-linux-repo.mjs) e sobem como assets da release, junto dos pacotes.
 *
 * Só sai redirecionamento para um nome da lista fechada abaixo e para a versão do catálogo validado
 * (github.com/Hiper-nexus/nexus-ide-releases). Nada vem da entrada do visitante além do nome conferido.
 */
import { readReleaseCatalog } from './catalog.js';

const REDIRECT_SECONDS = 300;
const VERSION = String.raw`\d+\.\d+\.\d+`;
const APT_FILE = new RegExp(String.raw`^(?:InRelease|Release|Release\.gpg|Packages|Packages\.gz|nexus-ide_(${VERSION})_amd64\.deb)$`, 'u');
const RPM_PACKAGE = new RegExp(String.raw`^nexus-ide-(${VERSION})-1\.x86_64\.rpm$`, 'u');
const RPM_METADATA = /^repodata\/(repomd\.xml(?:\.asc)?|[0-9a-f]{64}-(?:primary|filelists|other)\.xml\.(?:gz|zst))$/u;

/** Nome do asset na release para um caminho do repositório, ou null se o caminho não é do repositório. */
export function repoAsset(kind, path) {
  if (typeof path !== 'string' || path.length > 160 || path.includes('..') || path.includes('\\') || path.includes('//')) return null;
  if (kind === 'apt') {
    const match = APT_FILE.exec(path);
    return match ? { name: path, version: match[1] ?? null } : null;
  }
  if (kind === 'rpm') {
    const pkg = RPM_PACKAGE.exec(path);
    if (pkg) return { name: path, version: pkg[1] };
    const meta = RPM_METADATA.exec(path);
    // Asset de release não tem pasta: `repodata/x` vira `rpm-repodata-x`.
    return meta ? { name: `rpm-repodata-${meta[1]}`, version: null } : null;
  }
  return null;
}

function notFound() {
  return new Response('Not found', { status: 404, headers: { 'x-content-type-options': 'nosniff', 'cache-control': 'public, max-age=60' } });
}

/**
 * `GET /apt/<arquivo>` e `GET /rpm/<arquivo>`. Pacote de versão que não é a mais nova dá 404 (o índice só lista a mais
 * nova; quem pede outra quer um arquivo que o repositório não anuncia).
 */
export async function repoRedirectResponse(kind, path, deps = {}) {
  const asset = repoAsset(kind, path);
  if (!asset) return notFound();
  const payload = await readReleaseCatalog(deps);
  const latest = payload.catalog.linux?.[0];
  const reference = latest?.files.find(file => file.format === 'deb') ?? latest?.files[0];
  if (!latest || !reference) return notFound();
  if (asset.version && asset.version !== latest.version) return notFound();
  // O catálogo já só tem URLs do repositório público; a pasta da release é a da URL de qualquer arquivo dela.
  const base = reference.url.slice(0, reference.url.lastIndexOf('/') + 1);
  if (!base.startsWith('https://github.com/Hiper-nexus/nexus-ide-releases/releases/download/v')) return notFound();
  return new Response(null, { status: 302, headers: {
    location: `${base}${asset.name}`,
    'cache-control': `public, max-age=${REDIRECT_SECONDS}`,
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'strict-origin-when-cross-origin',
    'x-nexus-version': latest.version,
  } });
}
