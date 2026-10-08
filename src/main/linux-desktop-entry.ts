/**
 * Integração com o desktop no Linux: identidade da janela e entrada de menu.
 *
 * O login volta para o app pelo deep link `nexus://auth/<code>`. No Linux quem
 * entrega esse link é o handler de `x-scheme-handler/nexus`, e o handler é uma
 * entrada `.desktop`. Sem ela o navegador não tem para quem devolver o código
 * e o login nunca termina.
 *
 * - DEB/RPM instalam `/usr/share/applications/nexus-ide.desktop` (com
 *   `MimeType=x-scheme-handler/nexus;`, ver `forge.config.ts`). Aqui não há
 *   nada a escrever.
 * - O ZIP portátil não instala nada. No primeiro boot o app escreve a própria
 *   entrada em `$XDG_DATA_HOME/applications/nexus-ide.desktop`, apontando para
 *   o binário em execução, e a reescreve se a pasta for movida.
 *
 * O nome do arquivo precisa casar com `desktopName` do `package.json`: é dele
 * que o Electron tira o app_id do Wayland / WM_CLASS do X11 e o alvo de
 * `app.setAsDefaultProtocolClient`. Antes da 0.76.169 o Electron caía no slug
 * `nexuside.desktop`, que não existe em nenhum pacote.
 *
 * Doutrina: só escreve UM arquivo, dentro do diretório de dados do próprio
 * usuário, e só mexe em arquivo que ele mesmo criou (marcador
 * `X-NexusIDE-Portable=true`). Entrada feita à mão pelo operador é respeitada.
 * Nunca lança: integração de desktop não pode impedir o app de abrir.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Precisa casar com `desktopName` do package.json e com o nome dos makers. */
export const LINUX_DESKTOP_FILE_NAME = 'nexus-ide.desktop';
export const LINUX_PORTABLE_MARKER = 'X-NexusIDE-Portable=true';
/** Ícone da marca que viaja em `resources/` (ver `extraResource`). */
export const LINUX_RUNTIME_ICON_FILE = 'icon.png';
const DEEP_LINK_MIME = 'x-scheme-handler/nexus';
/** Uma entrada nossa nunca passa disto; arquivo maior não é nosso. */
const MAX_ENTRY_BYTES = 16 * 1024;
/** Índice de tipos do diretório de aplicativos (`update-desktop-database`). */
export const LINUX_MIME_CACHE_FILE = 'mimeinfo.cache';
const MIME_CACHE_GROUP = '[MIME Cache]';
const MAX_MIME_CACHE_BYTES = 4 * 1024 * 1024;
const UPDATE_DESKTOP_DATABASE_CANDIDATES = [
  '/usr/bin/update-desktop-database',
  '/bin/update-desktop-database',
  '/usr/local/bin/update-desktop-database',
] as const;

export interface LinuxRuntimeIconContext {
  platform: NodeJS.Platform;
  isPackaged: boolean;
  resourcesPath: string;
  appPath: string;
}

/**
 * Ícone concreto para `BrowserWindow` e para a entrada portátil. No X11 a
 * janela sem `icon` mostra o átomo do Electron; no Wayland o ícone vem da
 * entrada `.desktop`, que aponta para este mesmo arquivo.
 */
export function resolveLinuxRuntimeIconPath(
  context: LinuxRuntimeIconContext,
  fileExists: (candidate: string) => boolean = fs.existsSync,
): string | undefined {
  if (context.platform !== 'linux') return undefined;
  const candidate = context.isPackaged
    ? path.posix.join(context.resourcesPath, LINUX_RUNTIME_ICON_FILE)
    : path.posix.join(context.appPath, 'assets', LINUX_RUNTIME_ICON_FILE);
  return fileExists(candidate) ? candidate : undefined;
}

/**
 * Um argumento do `Exec=` conforme a Desktop Entry Specification: entre aspas
 * duplas, com `"`, `` ` ``, `$` e `\` escapados, e `%` dobrado (senão vira
 * field code). Devolve `null` para caminho que a spec não consegue carregar
 * (quebra de linha / caractere de controle): melhor não registrar do que
 * registrar um comando truncado.
 */
export function quoteDesktopExecArg(arg: string): string | null {
  // eslint-disable-next-line no-control-regex -- recusa caracteres de controle no argumento do Exec de propósito
  if (arg.length === 0 || /[\u0000-\u001f\u007f]/.test(arg)) return null;
  const escaped = arg.replace(/(["`$\\])/g, '\\$1').replace(/%/g, '%%');
  // O valor inteiro ainda passa pelo escape de string do arquivo .desktop,
  // onde `\` é o caractere de escape: cada barra vira duas.
  return `"${escaped}"`.replace(/\\/g, '\\\\');
}

/**
 * Caminho que pode ir no `Exec=` SEM aspas: nenhum caractere reservado da
 * spec, nenhum `%` e nenhum espaço em branco.
 *
 * Importa porque o `xdg-open` genérico (o caminho usado em Hyprland, sway e
 * qualquer desktop que não seja GNOME/KDE/XFCE…) NÃO entende `Exec` entre
 * aspas: ele trata `"/caminho/nexus-ide"` — com as aspas — como nome do
 * comando, não acha, e entrega o `nexus://` ao navegador. Medido no Omarchy
 * com xdg-utils e o Chromium padrão: o login voltava para uma aba em branco.
 */
export function isPlainDesktopExecPath(value: string): boolean {
  // eslint-disable-next-line no-control-regex -- o caminho do Exec não pode ter controle nem espaço: a classe casa controles de propósito
  return value.length > 0 && !/[\u0000-\u0020\u007f"'\\<>~|&;$*?#()`%]/.test(value);
}

export interface DesktopExecLink {
  /** Symlink sem caracteres reservados, apontando para o binário real. */
  path: string;
  target: string;
}

export interface DesktopExecToken {
  exec: string;
  link?: DesktopExecLink;
}

/**
 * O token do executável para o `Exec=`:
 *  1. caminho simples → vai cru (funciona em todo lançador);
 *  2. caminho com espaço ou reservado ("Área de Trabalho") → um symlink de
 *     nome simples no diretório de dados do usuário, e o `Exec` aponta para
 *     ele (o Electron resolve os recursos pelo binário real, como já faz com
 *     `/usr/bin/nexus-ide` no DEB);
 *  3. nem o symlink cabe cru → forma entre aspas da spec (GNOME/KDE abrem; o
 *     `xdg-open` genérico não).
 */
export function desktopExecToken(execPath: string, linkPath: string): DesktopExecToken | null {
  if (isPlainDesktopExecPath(execPath)) return { exec: execPath };
  const quoted = quoteDesktopExecArg(execPath);
  if (quoted === null) return null;
  if (isPlainDesktopExecPath(linkPath)) {
    return { exec: linkPath, link: { path: linkPath, target: execPath } };
  }
  return { exec: quoted };
}

export interface PortableDesktopEntryInput {
  /** Token já resolvido por `desktopExecToken` (cru ou entre aspas). */
  exec: string;
  iconPath?: string;
}

export function buildPortableDesktopEntry(input: PortableDesktopEntryInput): string {
  const exec = input.exec;
  // eslint-disable-next-line no-control-regex -- ícone com caractere de controle cai no nome padrão: a classe casa controles de propósito
  const icon = input.iconPath && !/[\u0000-\u001f\u007f]/.test(input.iconPath)
    ? input.iconPath.replace(/\\/g, '\\\\')
    : 'nexus-ide';
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Name=NexusIDE',
    'GenericName=IDE multi-agente',
    'Comment=Seu time de agentes de IA em um único cockpit de terminais',
    `Exec=${exec} %U`,
    `Icon=${icon}`,
    'Terminal=false',
    'StartupNotify=true',
    'StartupWMClass=nexus-ide',
    'Categories=Development;',
    `MimeType=${DEEP_LINK_MIME};`,
    LINUX_PORTABLE_MARKER,
    '',
  ].join('\n');
}

/**
 * Binário instalado por DEB/RPM: `/usr/lib/nexus-ide` ou `/usr/lib64/nexus-ide`.
 * `/opt`, `/usr/local` e `/usr/share` ficam de fora de propósito: é onde se
 * extrai o ZIP portátil. Casar `/usr/` inteiro apagava a entrada de quem tem o
 * DEB instalado E o ZIP em /usr/local/nexus.
 */
export function isPackageManagedExecutable(execPath: string): boolean {
  return /^\/usr\/lib(64)?\//.test(execPath);
}

export interface LinuxDesktopEntryInput {
  platform: NodeJS.Platform;
  isPackaged: boolean;
  /** Smoke/harness: nunca tocar no diretório de dados de quem roda o teste. */
  automatedTest: boolean;
  execPath: string;
  iconPath?: string;
  homeDir: string;
  env: Readonly<Record<string, string | undefined>>;
  /**
   * Conteúdo do arquivo, `null` se NÃO EXISTE, ou `undefined` se existe e não é
   * um arquivo comum pequeno que se possa ler (symlink de gerenciador de
   * dotfiles, FIFO, arquivo enorme, sem permissão): isso é do operador.
   */
  readEntry: (file: string) => string | null | undefined;
  entryExists: (file: string) => boolean;
  /** Alvo do symlink, `null` se não existe, `undefined` se NÃO é symlink. */
  readLink: (file: string) => string | null | undefined;
}

export type LinuxDesktopEntryPlan =
  | { action: 'none'; reason: string }
  | { action: 'write'; file: string; content: string; link?: DesktopExecLink }
  | { action: 'remove'; file: string; link: string };

function absoluteOr(value: string | undefined, fallback: string): string {
  return value && path.posix.isAbsolute(value) ? value : fallback;
}

function linuxDataHome(
  homeDir: string,
  env: Readonly<Record<string, string | undefined>>,
): string {
  return absoluteOr(env.XDG_DATA_HOME, path.posix.join(homeDir, '.local', 'share'));
}

export function linuxUserDesktopEntryPath(
  homeDir: string,
  env: Readonly<Record<string, string | undefined>>,
): string {
  return path.posix.join(linuxDataHome(homeDir, env), 'applications', LINUX_DESKTOP_FILE_NAME);
}

/** Onde mora o symlink do lançador quando o caminho real não cabe no `Exec`. */
export function linuxLauncherLinkPath(
  homeDir: string,
  env: Readonly<Record<string, string | undefined>>,
): string {
  return path.posix.join(linuxDataHome(homeDir, env), 'nexus-ide', 'nexus-ide');
}

function systemDesktopEntryPaths(
  env: Readonly<Record<string, string | undefined>>,
): string[] {
  // `/usr/share` entra sempre: é onde DEB e RPM instalam, mesmo que a sessão
  // tenha um XDG_DATA_DIRS que não o liste.
  const dirs = [
    ...(env.XDG_DATA_DIRS || '/usr/local/share:/usr/share').split(':'),
    '/usr/share',
  ].filter((dir) => path.posix.isAbsolute(dir));
  return [
    ...new Set(dirs.map((dir) => path.posix.join(dir, 'applications', LINUX_DESKTOP_FILE_NAME))),
  ];
}

function isOwnedEntry(content: string | null | undefined): boolean {
  return typeof content === 'string' && content.split('\n').includes(LINUX_PORTABLE_MARKER);
}

/** PURO: decide o que fazer com a entrada do usuário. */
export function planLinuxDesktopEntry(input: LinuxDesktopEntryInput): LinuxDesktopEntryPlan {
  if (input.platform !== 'linux') return { action: 'none', reason: 'not-linux' };
  if (!input.isPackaged) return { action: 'none', reason: 'not-packaged' };
  if (input.automatedTest) return { action: 'none', reason: 'automated-test' };
  if (!path.posix.isAbsolute(input.homeDir)) return { action: 'none', reason: 'no-home' };

  const userFile = linuxUserDesktopEntryPath(input.homeDir, input.env);
  const linkPath = linuxLauncherLinkPath(input.homeDir, input.env);
  const existing = input.readEntry(userFile);
  const owned = isOwnedEntry(existing);
  const systemInstalled = systemDesktopEntryPaths(input.env)
    .filter((file) => file !== userFile)
    .some((file) => input.entryExists(file));

  if (systemInstalled) {
    // A entrada do usuário tem precedência sobre a do sistema. Uma entrada
    // portátil antiga esconderia o app instalado e apontaria para uma pasta
    // que pode nem existir mais.
    if (owned && isPackageManagedExecutable(input.execPath)) {
      return { action: 'remove', file: userFile, link: linkPath };
    }
    return { action: 'none', reason: 'system-entry-present' };
  }
  if (existing !== null && !owned) return { action: 'none', reason: 'user-entry-present' };

  const token = desktopExecToken(input.execPath, linkPath);
  if (token === null) return { action: 'none', reason: 'unrepresentable-path' };
  let link = token.link;
  let exec = token.exec;
  if (link) {
    const current = input.readLink(link.path);
    if (current === undefined) {
      // Há um arquivo de verdade no lugar do symlink: não é nosso, não se
      // substitui. Sobra a forma entre aspas.
      link = undefined;
      exec = quoteDesktopExecArg(input.execPath) ?? exec;
    } else if (current === link.target) {
      link = undefined; // já aponta para o binário certo
    }
  }
  const content = buildPortableDesktopEntry({ exec, iconPath: input.iconPath });
  if (existing === content && !link) return { action: 'none', reason: 'up-to-date' };
  return { action: 'write', file: userFile, content, ...(link ? { link } : {}) };
}

/**
 * Para arquivos do operador que o app pode reescrever (entrada de menu e índice
 * de tipos): `null` = não existe; `undefined` = existe e não é um arquivo comum
 * pequeno (symlink, FIFO, enorme, sem permissão) — não se toca.
 */
function readUserFile(file: string, maxBytes: number): string | null | undefined {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size > maxBytes) return undefined;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'ENOENT' || code === 'ENOTDIR' ? null : undefined;
  }
  return readSmallRegularFile(file, maxBytes) ?? undefined;
}

/** Lê só arquivo comum e pequeno; symlink/FIFO/arquivo enorme = "não é nosso". */
function readSmallRegularFile(file: string, maxBytes: number = MAX_ENTRY_BYTES): string | null {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > maxBytes) return null;
    return fs.readFileSync(fd, 'utf8');
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* já fechado */
      }
    }
  }
}

/** `null` = não existe; `undefined` = existe e não é symlink (não é nosso). */
function readSymlink(file: string): string | null | undefined {
  try {
    return fs.readlinkSync(file);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? null : undefined;
  }
}

function replaceSymlink(link: DesktopExecLink): void {
  const dir = path.posix.dirname(link.path);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temp = `${link.path}.${process.pid}.tmp`;
  fs.rmSync(temp, { force: true });
  try {
    fs.symlinkSync(link.target, temp);
    fs.renameSync(temp, link.path);
  } catch (error) {
    fs.rmSync(temp, { force: true });
    throw error;
  }
}

function applyPlan(plan: LinuxDesktopEntryPlan): void {
  if (plan.action === 'remove') {
    fs.rmSync(plan.file, { force: true });
    // Só o symlink: um arquivo de verdade ali não foi criado por nós.
    if (typeof readSymlink(plan.link) === 'string') fs.rmSync(plan.link, { force: true });
    return;
  }
  if (plan.action !== 'write') return;
  if (plan.link) replaceSymlink(plan.link);
  const dir = path.posix.dirname(plan.file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  // Temporário ao lado + rename: um boot interrompido nunca deixa meia entrada,
  // e um symlink plantado no destino é substituído, não seguido.
  const temp = path.posix.join(dir, `.${LINUX_DESKTOP_FILE_NAME}.${process.pid}.tmp`);
  try {
    fs.writeFileSync(temp, plan.content, { mode: 0o644, flag: 'wx' });
    fs.renameSync(temp, plan.file);
  } catch (error) {
    fs.rmSync(temp, { force: true });
    throw error;
  }
}

/**
 * O índice de tipos lista o Nexus como app de `nexus://`?
 *
 * Definir o padrão (`mimeapps.list`, o que `setAsDefaultProtocolClient` faz)
 * não basta. O portal do desktop (xdg-desktop-portal, por onde o Chrome e os
 * apps em sandbox abrem links) e o GIO só oferecem apps REGISTRADOS para o
 * tipo, e o registro vem deste índice — não do `MimeType=` lido de cada
 * `.desktop`. Sem a linha, o login terminava em "Open With… No Apps
 * available" (F-740, medido no Omarchy com xdg-desktop-portal 1.22).
 */
export function mimeCacheListsHandler(cacheText: string | null): boolean {
  if (cacheText === null) return false;
  let inGroup = false;
  for (const raw of cacheText.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('[')) {
      inGroup = line === MIME_CACHE_GROUP;
      continue;
    }
    if (!inGroup || !line.startsWith(`${DEEP_LINK_MIME}=`)) continue;
    if (line.slice(DEEP_LINK_MIME.length + 1).split(';').includes(LINUX_DESKTOP_FILE_NAME)) {
      return true;
    }
  }
  return false;
}

/**
 * Último recurso, quando `update-desktop-database` não existe na máquina:
 * acrescenta a nossa linha ao índice sem tocar nas dos outros. O formato é o
 * mesmo keyfile que a ferramenta gera, e a próxima execução dela reescreve o
 * arquivo inteiro a partir dos `.desktop` — incluindo o nosso.
 */
export function mergeMimeCacheHandler(cacheText: string | null): string {
  const ours = `${DEEP_LINK_MIME}=${LINUX_DESKTOP_FILE_NAME};`;
  if (cacheText === null || cacheText.trim() === '') return `${MIME_CACHE_GROUP}\n${ours}\n`;
  const lines = cacheText.replace(/\n+$/, '').split('\n');
  let inGroup = false;
  let groupSeen = false;
  let insertAt = lines.length;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (line.startsWith('[')) {
      if (inGroup) insertAt = index;
      inGroup = line === MIME_CACHE_GROUP;
      groupSeen = groupSeen || inGroup;
      continue;
    }
    if (inGroup && line.startsWith(`${DEEP_LINK_MIME}=`)) {
      const apps = line.slice(DEEP_LINK_MIME.length + 1).split(';').filter(Boolean);
      if (!apps.includes(LINUX_DESKTOP_FILE_NAME)) apps.unshift(LINUX_DESKTOP_FILE_NAME);
      lines[index] = `${DEEP_LINK_MIME}=${apps.join(';')};`;
      return `${lines.join('\n')}\n`;
    }
  }
  if (!groupSeen) return `${lines.join('\n')}\n${MIME_CACHE_GROUP}\n${ours}\n`;
  lines.splice(insertAt, 0, ours);
  return `${lines.join('\n')}\n`;
}

export interface MimeIndexDeps {
  /** `null` = não existe; `undefined` = existe e não é arquivo comum (não se toca). */
  readCache: (file: string) => string | null | undefined;
  /** Roda `update-desktop-database <dir>`; `false` se não existe ou falhou. */
  runUpdateDesktopDatabase: (applicationsDir: string) => boolean;
  writeCache: (file: string, content: string) => void;
}

export type MimeIndexOutcome = 'already-listed' | 'updated' | 'merged' | 'skipped';

/** Garante a linha no índice: a ferramenta do sistema primeiro, a mescla depois. */
export function ensureMimeIndex(applicationsDir: string, deps: MimeIndexDeps): MimeIndexOutcome {
  const cacheFile = path.posix.join(applicationsDir, LINUX_MIME_CACHE_FILE);
  const before = deps.readCache(cacheFile);
  // Um índice que existe mas não é arquivo comum (symlink de dotfiles…) é do
  // operador: nem a ferramenta nem a mescla o reescrevem.
  if (before === undefined) return 'skipped';
  if (mimeCacheListsHandler(before)) return 'already-listed';
  if (deps.runUpdateDesktopDatabase(applicationsDir)) {
    const after = deps.readCache(cacheFile);
    if (mimeCacheListsHandler(after ?? null)) return 'updated';
    if (after === undefined) return 'skipped';
    deps.writeCache(cacheFile, mergeMimeCacheHandler(after));
    return 'merged';
  }
  deps.writeCache(cacheFile, mergeMimeCacheHandler(before));
  return 'merged';
}

function runUpdateDesktopDatabase(applicationsDir: string): boolean {
  for (const tool of UPDATE_DESKTOP_DATABASE_CANDIDATES) {
    if (!fs.existsSync(tool)) continue;
    try {
      // argv fixo, sem shell; o diretório é derivado do home do operador.
      execFileSync(tool, [applicationsDir], { timeout: 5_000, stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

function writeFileAtomic(file: string, content: string): void {
  const temp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temp, content, { mode: 0o644, flag: 'wx' });
    fs.renameSync(temp, file);
  } catch (error) {
    fs.rmSync(temp, { force: true });
    throw error;
  }
}

const SYSTEM_MIME_INDEX_DEPS: MimeIndexDeps = {
  readCache: (file) => readUserFile(file, MAX_MIME_CACHE_BYTES),
  runUpdateDesktopDatabase,
  writeCache: writeFileAtomic,
};

export interface EnsureLinuxDesktopEntryOptions {
  platform?: NodeJS.Platform;
  isPackaged: boolean;
  automatedTest: boolean;
  execPath: string;
  resourcesPath: string;
  appPath: string;
  homeDir?: string;
  env?: Readonly<Record<string, string | undefined>>;
  /** Seam de teste; o padrão usa a ferramenta e os arquivos reais. */
  mimeIndex?: MimeIndexDeps;
}

/**
 * Borda: aplica o plano. Chame ANTES de `app.setAsDefaultProtocolClient`, que
 * só registra o handler se a entrada `.desktop` já existir. Nunca lança.
 */
export function ensureLinuxDesktopEntry(
  options: EnsureLinuxDesktopEntryOptions,
): LinuxDesktopEntryPlan {
  const platform = options.platform ?? process.platform;
  try {
    const plan = planLinuxDesktopEntry({
      platform,
      isPackaged: options.isPackaged,
      automatedTest: options.automatedTest,
      execPath: options.execPath,
      iconPath: resolveLinuxRuntimeIconPath({
        platform,
        isPackaged: options.isPackaged,
        resourcesPath: options.resourcesPath,
        appPath: options.appPath,
      }),
      homeDir: options.homeDir ?? os.homedir(),
      env: options.env ?? process.env,
      readEntry: (file) => readUserFile(file, MAX_ENTRY_BYTES),
      entryExists: (file) => fs.existsSync(file),
      readLink: readSymlink,
    });
    applyPlan(plan);
    // A entrada portátil é nossa (acabou de ser escrita ou já estava em dia):
    // o índice de tipos precisa listá-la, senão o portal não acha o app.
    // Conferido a cada boot — um índice regenerado sem a nossa linha se cura.
    if (plan.action === 'write' || (plan.action === 'none' && plan.reason === 'up-to-date')) {
      const homeDir = options.homeDir ?? os.homedir();
      const userFile = linuxUserDesktopEntryPath(homeDir, options.env ?? process.env);
      ensureMimeIndex(path.posix.dirname(userFile), options.mimeIndex ?? SYSTEM_MIME_INDEX_DEPS);
    } else if (plan.action === 'remove') {
      // Tira do índice a linha da entrada portátil que acabou de sair.
      runUpdateDesktopDatabase(path.posix.dirname(plan.file));
    }
    return plan;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.warn(`[desktop-entry] entrada de menu do Linux não atualizada: ${reason.slice(0, 160)}`);
    return { action: 'none', reason: 'failed' };
  }
}
