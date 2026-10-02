import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Confere a identidade de desktop de um pacote Linux INSTALADO (DEB/RPM).
 *
 * Até a 0.76.168 os pacotes saíram com o ícone padrão do Electron e sem o
 * handler `x-scheme-handler/nexus`: o app aparecia no menu com o átomo do
 * Electron e o login pelo navegador não tinha como voltar. O smoke empacotado
 * não vê nada disso (abre o binário direto), então a conferência é estática,
 * sobre os arquivos que o gerenciador de pacotes realmente gravou.
 */
export const DESKTOP_ENTRY_PATH = '/usr/share/applications/nexus-ide.desktop';
export const INSTALLED_ICON_PATH = '/usr/share/pixmaps/nexus-ide.png';
/** Índice que o gatilho do desktop-file-utils atualiza na instalação. */
export const MIME_CACHE_PATH = '/usr/share/applications/mimeinfo.cache';
export const DEEP_LINK_MIME_TYPE = 'x-scheme-handler/nexus';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** Chaves do grupo [Desktop Entry]; a primeira ocorrência vence, como na spec. */
export function parseDesktopEntry(text) {
  const keys = new Map();
  let inMainGroup = false;
  for (const raw of String(text).split(/\r?\n/u)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('[')) {
      inMainGroup = line === '[Desktop Entry]';
      continue;
    }
    if (!inMainGroup) continue;
    const separator = line.indexOf('=');
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    if (!keys.has(key)) keys.set(key, line.slice(separator + 1).trim());
  }
  return keys;
}

const listValue = (value) => String(value ?? '').split(';').filter(Boolean);

/** PURO: devolve a lista de problemas (vazia = identidade correta). */
/** O índice lista a entrada como app de nexus://? (só o grupo [MIME Cache]) */
export function mimeCacheListsHandler(text, desktopFile) {
  if (typeof text !== 'string') return false;
  let inGroup = false;
  for (const raw of text.split(/\r?\n/u)) {
    const line = raw.trim();
    if (line.startsWith('[')) {
      inGroup = line === '[MIME Cache]';
      continue;
    }
    if (!inGroup || !line.startsWith(`${DEEP_LINK_MIME_TYPE}=`)) continue;
    if (listValue(line.slice(DEEP_LINK_MIME_TYPE.length + 1)).includes(desktopFile)) return true;
  }
  return false;
}

export function desktopIdentityProblems({
  desktopEntry,
  installedIcon,
  brandIcon,
  installerDefaultIcons = [],
  desktopName,
  mimeCache,
}) {
  const problems = [];
  const expectedName = path.posix.basename(DESKTOP_ENTRY_PATH);
  if (desktopName !== expectedName) {
    problems.push(
      `package.json desktopName é ${JSON.stringify(desktopName)}; precisa ser ${expectedName} ` +
        '(é dele que o Electron tira o app_id e o alvo do handler nexus://)',
    );
  }
  if (typeof desktopEntry !== 'string') {
    problems.push(`${DESKTOP_ENTRY_PATH} não foi instalado`);
  } else {
    const entry = parseDesktopEntry(desktopEntry);
    if (!listValue(entry.get('MimeType')).includes(DEEP_LINK_MIME_TYPE)) {
      problems.push(`a entrada de menu não declara MimeType=${DEEP_LINK_MIME_TYPE}; (login não volta ao app)`);
    }
    if (entry.get('Exec') !== 'nexus-ide %U') {
      problems.push(`Exec inesperado: ${JSON.stringify(entry.get('Exec'))}`);
    }
    if (entry.get('Icon') !== 'nexus-ide') {
      problems.push(`Icon inesperado: ${JSON.stringify(entry.get('Icon'))}`);
    }
    if (!listValue(entry.get('Categories')).includes('Development')) {
      problems.push('a entrada de menu não está na categoria Development');
    }
  }
  // `undefined` = quem chama não conferiu o índice (teste de unidade antigo);
  // a conferência do pacote instalado sempre passa o texto ou `null`.
  if (mimeCache !== undefined && !mimeCacheListsHandler(mimeCache, expectedName)) {
    problems.push(
      `${MIME_CACHE_PATH} não lista ${expectedName} para ${DEEP_LINK_MIME_TYPE} ` +
        '(o portal do desktop não oferece o Nexus e o login termina em "No Apps available")',
    );
  }
  if (!Buffer.isBuffer(installedIcon)) {
    problems.push(`${INSTALLED_ICON_PATH} não foi instalado`);
  } else {
    const digest = sha256(installedIcon);
    if (installerDefaultIcons.some((icon) => sha256(icon) === digest)) {
      problems.push('o ícone instalado é o padrão do Electron, não o da marca');
    } else if (!Buffer.isBuffer(brandIcon) || sha256(brandIcon) !== digest) {
      problems.push('o ícone instalado difere de assets/icon.png');
    }
  }
  return problems;
}

function readOptional(file, encoding) {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile()) return undefined;
    return fs.readFileSync(file, encoding);
  } catch {
    return undefined;
  }
}

export function verifyInstalledDesktopIdentity(root = process.cwd()) {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  return desktopIdentityProblems({
    desktopEntry: readOptional(DESKTOP_ENTRY_PATH, 'utf8'),
    installedIcon: readOptional(INSTALLED_ICON_PATH),
    brandIcon: readOptional(path.join(root, 'assets', 'icon.png')),
    installerDefaultIcons: ['electron-installer-debian', 'electron-installer-redhat']
      .map((name) => readOptional(path.join(root, 'node_modules', name, 'resources', 'icon.png')))
      .filter(Buffer.isBuffer),
    desktopName: pkg.desktopName,
    mimeCache: readOptional(MIME_CACHE_PATH, 'utf8') ?? null,
  });
}

/** `argv[1]` pode vir por um caminho com symlink; `import.meta.url` já é o real. */
function isMainModule() {
  try {
    return fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isMainModule()) {
  const problems = verifyInstalledDesktopIdentity();
  if (problems.length > 0) {
    for (const problem of problems) process.stderr.write(`[linux-desktop-identity] FAIL: ${problem}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(
      `[linux-desktop-identity] ok: ${DESKTOP_ENTRY_PATH} registra ${DEEP_LINK_MIME_TYPE}, ` +
        'o índice de tipos lista a entrada e o ícone é o da marca\n',
    );
  }
}
