/**
 * Nexus Redline no Linux — a bandeja DENTRO do app em execução.
 *
 * Mac e Windows têm um companheiro à parte (Swift / C++). No Linux v1 o
 * Redline é um `Tray` + `Menu` do Electron (StatusNotifierItem: KDE, GNOME com
 * AppIndicator, XFCE, Waybar/Hyprland). Sem toolchain nativa nova, viaja nos
 * pacotes DEB/RPM/ZIP e funciona em qualquer distro. Limites honestos:
 *   - vive só enquanto o NexusIDE está aberto (no Mac/Windows o companheiro
 *     continua depois de fechar o app);
 *   - Wayland não deixa a bandeja posicionar um painel, então o painel escuro
 *     400×600 vira uma lista de menu nativa;
 *   - o Electron não diz se algum host de bandeja está exibindo o ícone: o
 *     estado `running` quer dizer "o Tray foi criado", não "alguém o vê".
 *
 * Doutrina (igual aos companheiros): read-only sobre
 * `~/.nexus/redline-last-good.json` (validado por `redline-snapshot-parse`,
 * nunca confiado), nenhuma rede, nenhum segredo, caminhos só derivados do
 * home. O único efeito colateral é o arquivo-sinal `redline-refresh.request`
 * ("Atualizar agora"), que o sink do próprio Nexus já consome.
 *
 * Toda decisão e formatação vive em `redline-tray-model.ts` (puro); aqui só há
 * ciclo de vida: criar/destruir o Tray, vigiar o arquivo, trocar ícone/menu.
 */

import {
  closeSync,
  constants as fsConstants,
  mkdirSync,
  openSync,
  watch as fsWatch,
  writeSync,
} from 'node:fs';
import {
  Menu,
  Tray,
  nativeImage,
  type MenuItemConstructorOptions,
  type NativeImage,
} from 'electron';
import {
  REDLINE_SNAPSHOT_FILENAME,
  type RedlineInAppTrayStatus,
  type RedlineSnapshotFile,
} from '../../shared/redline-types';
import {
  resolveRedlineHome,
  resolveRedlineRefreshPath,
  resolveRedlineSnapshotPath,
} from '../quota/redline-sink';
import { readRegularFileCapped } from './redline-safe-read';
import { REDLINE_SNAPSHOT_MAX_BYTES, parseRedlineSnapshot } from './redline-snapshot-parse';
import {
  readRedlineLinuxEnabled,
  writeRedlineLinuxEnabled,
} from './redline-linux-settings';
import { redlineTrayIconPng } from './redline-tray-icon';
import {
  buildRedlineTrayModel,
  type RedlineMenuItem,
  type RedlineTrayAction,
  type RedlineTrayModel,
} from './redline-tray-model';

/** Poll de segurança: contagem regressiva, "dado velho" e watcher que falhou. */
export const REDLINE_LINUX_POLL_MS = 30_000;
/** Junta a rajada de eventos do rename atômico num único reload. */
export const REDLINE_LINUX_DEBOUNCE_MS = 250;
/**
 * Sem mudança no arquivo, o menu só é republicado a cada 5 min (a contagem
 * regressiva e a idade andam, mas republicar fecha o menu aberto em vários
 * hosts). Arquivo novo, ícone que muda ou dado que fica velho publicam já.
 */
export const REDLINE_LINUX_MENU_REFRESH_MS = 5 * 60_000;
/** O PNG tem 64 px e entra como @2x (32 DIP): nítido em 22–48 px. */
const ICON_SCALE_FACTOR = 2;
const FAILURE_REASON_MAX = 100;

export interface RedlineLinuxDirectoryWatcher {
  close(): void;
}

export interface RedlineLinuxDeps {
  /** `app.getPath('userData')`: onde mora a preferência ligado/desligado. */
  userDataDir: string;
  /** Foca a janela principal e abre Uso e cotas (read-only). */
  openQuota: () => void;
  /** Home do operador (seam de teste); o snapshot vive em `<home>/.nexus`. */
  homedir?: string;
  now?: () => number;
  platform?: NodeJS.Platform;
  /**
   * Vigia o diretório do snapshot (seam de teste). Pode lançar. `onDead` avisa
   * que o vigia morreu sozinho (inotify esgotado, diretório removido).
   */
  watchDirectory?: (
    dir: string,
    onChange: () => void,
    onDead: () => void,
  ) => RedlineLinuxDirectoryWatcher;
}

export interface RedlineLinuxController {
  /** Boot: sobe a bandeja só se o operador já ligou. */
  startIfEnabled(): RedlineInAppTrayStatus;
  /** Liga e persiste. Se o ícone não puder ser criado, NÃO persiste. */
  enable(): RedlineInAppTrayStatus;
  /** Desliga e persiste. */
  disable(): RedlineInAppTrayStatus;
  /** Encerra a bandeja sem mexer na preferência (quit do app). */
  stop(): void;
  status(): RedlineInAppTrayStatus;
}

const O_NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0;

/**
 * Escreve o arquivo-sinal sem seguir symlink plantado no lugar (O_NOFOLLOW) e
 * privado ao usuário. Mesmo corpo do companheiro do Windows.
 */
function writeRefreshSignal(file: string, dir: string, nowMs: number): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const fd = openSync(
    file,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | O_NOFOLLOW,
    0o600,
  );
  try {
    writeSync(fd, refreshRequestBody(nowMs));
  } finally {
    closeSync(fd);
  }
}

/** Corpo do arquivo-sinal: igual ao do companheiro do Windows. */
export function refreshRequestBody(nowMs: number): string {
  return `{"source":"tray","at":${Math.trunc(nowMs)}}\n`;
}

/** `&` é acelerador (mnemônico) em rótulo de menu do Electron; `&&` é literal. */
export function escapeMenuLabel(text: string): string {
  return text.replace(/&/g, '&&');
}

function defaultWatchDirectory(
  dir: string,
  onChange: () => void,
  onDead: () => void,
): RedlineLinuxDirectoryWatcher {
  const watcher = fsWatch(dir, { persistent: false }, (_event, filename) => {
    // Sem nome (alguns FS) ou o alvo / seu temporário: vale recarregar.
    if (!filename || String(filename).includes(REDLINE_SNAPSHOT_FILENAME)) onChange();
  });
  // inotify esgotado (ENOSPC) ou diretório removido: o poll cobre e rearma.
  watcher.on('error', () => {
    watcher.close();
    onDead();
  });
  return watcher;
}

function shortReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, ' ').trim().slice(0, FAILURE_REASON_MAX);
}

function toTemplate(
  items: readonly RedlineMenuItem[],
  onAction: (action: RedlineTrayAction) => void,
): MenuItemConstructorOptions[] {
  return items.map((item): MenuItemConstructorOptions => {
    switch (item.kind) {
      case 'separator':
        return { type: 'separator' };
      case 'info':
        return { label: escapeMenuLabel(item.text), enabled: false };
      case 'action':
        return { label: escapeMenuLabel(item.text), click: () => onAction(item.action) };
      case 'submenu':
        return { label: escapeMenuLabel(item.text), submenu: toTemplate(item.items, onAction) };
    }
  });
}

/** O que já está publicado no Tray; `null` = ainda não publicado. */
interface AppliedState {
  icon: string;
  tooltip: string | null;
  menu: string | null;
}

function iconKeyOf(model: RedlineTrayModel): string {
  return `${model.urgency}:${model.stale}`;
}

export function createRedlineLinuxController(deps: RedlineLinuxDeps): RedlineLinuxController {
  const platform = deps.platform ?? process.platform;
  const now = deps.now ?? Date.now;
  const watchDirectory = deps.watchDirectory ?? defaultWatchDirectory;
  const snapshotPath = resolveRedlineSnapshotPath(deps.homedir);
  const refreshPath = resolveRedlineRefreshPath(deps.homedir);
  const snapshotDir = resolveRedlineHome(deps.homedir);

  let tray: Tray | null = null;
  let watcher: RedlineLinuxDirectoryWatcher | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let snapshot: RedlineSnapshotFile | null = null;
  let snapshotStamp = '';
  let applied: AppliedState | null = null;
  let menuPublishedAt = 0;
  let failureReason: string | undefined;
  let warned = false;

  const supported = platform === 'linux';

  function warnOnce(error: unknown): void {
    if (warned) return;
    warned = true;
    console.warn(`[redline] bandeja do Linux indisponível: ${shortReason(error)}`);
  }

  // ── Snapshot ────────────────────────────────────────────────────────────

  /**
   * Relê o arquivo só quando mtime/tamanho mudaram. Nunca lança. Devolve true
   * quando o que se sabe do arquivo mudou (inclusive sumir ou ficar inválido).
   */
  function reloadSnapshotIfChanged(): boolean {
    const result = readRegularFileCapped(snapshotPath, REDLINE_SNAPSHOT_MAX_BYTES, snapshotStamp);
    if (result.kind === 'unchanged') return false;
    const changed = result.stamp !== snapshotStamp;
    snapshot = result.kind === 'text' ? parseRedlineSnapshot(result.text) : null;
    snapshotStamp = result.stamp;
    return changed;
  }

  // ── Menu / ícone ────────────────────────────────────────────────────────

  function onAction(action: RedlineTrayAction): void {
    try {
      if (action === 'refresh') requestRefresh();
      else if (action === 'open-quota') deps.openQuota();
      // Destruir o Tray de dentro do clique do próprio menu derruba hosts de
      // bandeja: o desligar roda no turno seguinte.
      else setImmediate(hideFromMenu);
    } catch (error) {
      console.warn(`[redline] ação da bandeja falhou: ${shortReason(error)}`);
    }
  }

  function hideFromMenu(): void {
    try {
      disable();
    } catch (error) {
      console.warn(`[redline] não consegui ocultar a bandeja: ${shortReason(error)}`);
    }
  }

  function requestRefresh(): void {
    writeRefreshSignal(refreshPath, snapshotDir, now());
  }

  function iconFor(model: RedlineTrayModel): NativeImage {
    return nativeImage.createFromBuffer(redlineTrayIconPng(model.urgency, model.stale), {
      scaleFactor: ICON_SCALE_FACTOR,
    });
  }

  /**
   * Aplica só o que mudou. Tooltip e ícone andam livremente; o menu, só
   * quando o arquivo mudou, o ícone virou ou passaram 5 min (republicar o menu
   * aberto o fecha em vários hosts).
   */
  function render(snapshotChanged: boolean): void {
    if (!tray) return;
    if (tray.isDestroyed()) {
      // O sistema derrubou o ícone por baixo de nós: nada a atualizar, e
      // seguir tentando só encheria o log. Marca e solta os vigias.
      failureReason = 'O ícone da bandeja foi fechado pelo sistema.';
      teardown();
      return;
    }
    const at = now();
    const model = buildRedlineTrayModel(snapshot, at);
    const iconKey = iconKeyOf(model);
    const menuKey = JSON.stringify(model.items);
    const before = applied;
    const iconChanged = before === null || before.icon !== iconKey;
    if (iconChanged) tray.setImage(iconFor(model));
    if (before === null || before.tooltip !== model.tooltip) tray.setToolTip(model.tooltip);
    let publishedMenu = before?.menu ?? null;
    const menuDue =
      snapshotChanged ||
      iconChanged ||
      publishedMenu === null ||
      at - menuPublishedAt >= REDLINE_LINUX_MENU_REFRESH_MS;
    if (menuDue && publishedMenu !== menuKey) {
      tray.setContextMenu(Menu.buildFromTemplate(toTemplate(model.items, onAction)));
      publishedMenu = menuKey;
      menuPublishedAt = at;
    }
    applied = { icon: iconKey, tooltip: model.tooltip, menu: publishedMenu };
  }

  function refreshView(): void {
    try {
      render(reloadSnapshotIfChanged());
    } catch (error) {
      warnOnce(error);
    }
  }

  function scheduleReload(): void {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      refreshView();
    }, REDLINE_LINUX_DEBOUNCE_MS);
    debounceTimer.unref?.();
  }

  // ── Ciclo de vida ───────────────────────────────────────────────────────

  function teardown(): void {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = null;
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
    try {
      watcher?.close();
    } catch {
      /* watcher já morto */
    }
    watcher = null;
    const current = tray;
    tray = null;
    applied = null;
    menuPublishedAt = 0;
    snapshot = null;
    snapshotStamp = '';
    try {
      if (current && !current.isDestroyed()) current.destroy();
    } catch {
      /* já destruído */
    }
  }

  /** Liga o vigia do diretório se ainda não há um; falha = só o poll cobre. */
  function armWatcher(): void {
    if (watcher) return;
    try {
      watcher = watchDirectory(snapshotDir, scheduleReload, () => {
        watcher = null;
      });
    } catch {
      watcher = null; // diretório ausente ou inotify esgotado: o poll tenta de novo.
    }
  }

  /** Cria o Tray e liga os vigias. Devolve false (e guarda o motivo) se falhar. */
  function startTray(): boolean {
    if (tray) return true;
    try {
      snapshot = null;
      snapshotStamp = '';
      reloadSnapshotIfChanged();
      const model = buildRedlineTrayModel(snapshot, now());
      tray = new Tray(iconFor(model));
      // Clique esquerdo (Activate do StatusNotifierItem): abre o painel de
      // cotas dentro do Nexus. O menu fica no clique direito; sem isto o
      // clique não fazia nada e o Redline parecia "não abrir" (F-750).
      tray.on('click', () => onAction('open-quota'));
      // O Tray já nasce com o ícone certo; falta publicar tooltip e menu.
      applied = { icon: iconKeyOf(model), tooltip: null, menu: null };
      render(true);
      if (!tray) throw new Error('o ícone da bandeja foi destruído ao nascer');
    } catch (error) {
      warnOnce(error);
      failureReason = `Não consegui criar o ícone na bandeja (${shortReason(error)}).`;
      teardown();
      return false;
    }
    failureReason = undefined;
    armWatcher();
    pollTimer = setInterval(() => {
      armWatcher();
      refreshView();
    }, REDLINE_LINUX_POLL_MS);
    pollTimer.unref?.();
    return true;
  }

  function status(): RedlineInAppTrayStatus {
    if (!supported) return { enabled: false, state: 'off' };
    const enabled = readRedlineLinuxEnabled(deps.userDataDir);
    if (tray) return { enabled, state: 'running' };
    if (enabled && failureReason) {
      return { enabled, state: 'unavailable', reason: failureReason };
    }
    return { enabled, state: 'off' };
  }

  function startIfEnabled(): RedlineInAppTrayStatus {
    if (supported && readRedlineLinuxEnabled(deps.userDataDir)) startTray();
    return status();
  }

  function enable(): RedlineInAppTrayStatus {
    if (!supported) return status();
    if (!startTray()) {
      // Não persiste: o operador pediu e não aconteceu — nada de "ligado" fantasma.
      return { enabled: false, state: 'unavailable', reason: failureReason };
    }
    try {
      writeRedlineLinuxEnabled(deps.userDataDir, true);
    } catch (error) {
      // Ligou, mas não vai lembrar no próximo boot: melhor desfazer e dizer.
      console.warn(`[redline] preferência da bandeja não salva: ${shortReason(error)}`);
      failureReason = 'Não consegui salvar a preferência da bandeja.';
      teardown();
      return { enabled: false, state: 'unavailable', reason: failureReason };
    }
    return status();
  }

  function disable(): RedlineInAppTrayStatus {
    if (!supported) return status();
    teardown();
    failureReason = undefined;
    writeRedlineLinuxEnabled(deps.userDataDir, false);
    return status();
  }

  return {
    startIfEnabled,
    enable,
    disable,
    stop: () => {
      if (supported) teardown();
    },
    status,
  };
}
