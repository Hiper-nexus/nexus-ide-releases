import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

const fake = vi.hoisted(() => {
  interface MenuTemplateItem {
    label?: string;
    type?: string;
    enabled?: boolean;
    click?: () => void;
    submenu?: MenuTemplateItem[];
  }
  class FakeTray {
    static instances: FakeTray[] = [];
    static failWith: Error | null = null;
    image: unknown;
    tooltip = '';
    menu: { template: MenuTemplateItem[] } | null = null;
    destroyed = false;
    setImageCalls = 0;
    setToolTipCalls = 0;
    setContextMenuCalls = 0;
    listeners = new Map<string, () => void>();
    on(event: string, listener: () => void): this {
      this.listeners.set(event, listener);
      return this;
    }
    constructor(image: unknown) {
      if (FakeTray.failWith) throw FakeTray.failWith;
      this.image = image;
      FakeTray.instances.push(this);
    }
    setImage(image: unknown): void {
      this.image = image;
      this.setImageCalls += 1;
    }
    setToolTip(text: string): void {
      this.tooltip = text;
      this.setToolTipCalls += 1;
    }
    setContextMenu(menu: { template: MenuTemplateItem[] }): void {
      this.menu = menu;
      this.setContextMenuCalls += 1;
    }
    isDestroyed(): boolean {
      return this.destroyed;
    }
    destroy(): void {
      this.destroyed = true;
    }
  }
  return {
    FakeTray,
    createFromBuffer: vi.fn((buffer: Buffer, options: unknown) => ({ buffer, options })),
    buildFromTemplate: vi.fn((template: MenuTemplateItem[]) => ({ template })),
  };
});

vi.mock('electron', () => ({
  Tray: fake.FakeTray,
  Menu: { buildFromTemplate: fake.buildFromTemplate },
  nativeImage: { createFromBuffer: fake.createFromBuffer },
}));

import {
  REDLINE_LINUX_DEBOUNCE_MS,
  REDLINE_LINUX_MENU_REFRESH_MS,
  REDLINE_LINUX_POLL_MS,
  createRedlineLinuxController,
  escapeMenuLabel,
  refreshRequestBody,
  type RedlineLinuxController,
  type RedlineLinuxDeps,
} from './redline-linux';
import {
  REDLINE_LINUX_SETTINGS_FILE,
  readRedlineLinuxEnabled,
  writeRedlineLinuxEnabled,
} from './redline-linux-settings';

const NOW = 1_780_000_000_000;

function snapshotJson(overrides: Record<string, unknown> = {}, label = 'Claude Pessoal'): string {
  return JSON.stringify({
    formatVersion: 1,
    generatedBy: 'nexus',
    updatedAt: NOW,
    worstUsedRatio: 0.62,
    entries: [
      {
        id: 'claude:a',
        adapterId: 'claude',
        label,
        active: true,
        installed: true,
        onCooldown: false,
        windows: [
          { kind: 'hours', label: '5 Horas', usedRatio: 0.62, resetsAt: NOW + 80 * 60_000 },
          { kind: 'weekly', label: 'Semanal', usedRatio: 0.4 },
        ],
        updatedAt: NOW,
        eligible: true,
      },
    ],
    ranking: {},
    statusBarEntryIds: ['claude:a'],
    ...overrides,
  });
}

type Template = ReturnType<typeof fake.buildFromTemplate>['template'];

function labels(template: Template): string[] {
  return template.map((item) => (item.type === 'separator' ? '---' : (item.label ?? '')));
}

describe('redline linux controller', () => {
  let home: string;
  let userData: string;
  let now = NOW;
  let openQuota: Mock<() => void>;
  let watchers: Array<{ onChange: () => void; onDead: () => void; closed: boolean }>;
  let watchShouldThrow = false;
  let warn: ReturnType<typeof vi.spyOn>;

  const snapshotFile = () => path.join(home, '.nexus', 'redline-last-good.json');

  function writeSnapshot(body: string, mtimeSeconds?: number): void {
    mkdirSync(path.dirname(snapshotFile()), { recursive: true });
    writeFileSync(snapshotFile(), body);
    if (mtimeSeconds !== undefined) utimesSync(snapshotFile(), mtimeSeconds, mtimeSeconds);
  }

  function make(overrides: Partial<RedlineLinuxDeps> = {}): RedlineLinuxController {
    return createRedlineLinuxController({
      userDataDir: userData,
      homedir: home,
      now: () => now,
      platform: 'linux',
      openQuota,
      watchDirectory: (_dir, onChange, onDead) => {
        if (watchShouldThrow) throw new Error('ENOENT');
        const handle = { onChange, onDead, closed: false };
        watchers.push(handle);
        return {
          close: () => {
            handle.closed = true;
          },
        };
      },
      ...overrides,
    });
  }

  const tray = () => fake.FakeTray.instances.at(-1);
  const menuLabels = () => labels(tray()?.menu?.template ?? []);

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), 'redline-linux-home-'));
    userData = mkdtempSync(path.join(tmpdir(), 'redline-linux-userdata-'));
    now = NOW;
    openQuota = vi.fn<() => void>();
    watchers = [];
    watchShouldThrow = false;
    fake.FakeTray.instances = [];
    fake.FakeTray.failWith = null;
    fake.createFromBuffer.mockClear();
    fake.buildFromTemplate.mockClear();
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    warn.mockRestore();
    rmSync(home, { recursive: true, force: true });
    rmSync(userData, { recursive: true, force: true });
  });

  describe('opt-in and platform gating', () => {
    it('is ON by default: the first boot shows the tray without a saved choice (F-739)', () => {
      const status = make().startIfEnabled();
      expect(status).toEqual({ enabled: true, state: 'running' });
      expect(fake.FakeTray.instances).toHaveLength(1);
    });

    it('a left click on the icon opens the quota panel inside Nexus (F-750)', () => {
      make().startIfEnabled();
      expect(openQuota).not.toHaveBeenCalled();
      fake.FakeTray.instances[0].listeners.get('click')?.();
      expect(openQuota).toHaveBeenCalledOnce();
    });

    it('boot creates nothing once the operator hid it', () => {
      writeRedlineLinuxEnabled(userData, false);
      const status = make().startIfEnabled();
      expect(status).toEqual({ enabled: false, state: 'off' });
      expect(fake.FakeTray.instances).toHaveLength(0);
      expect(fake.createFromBuffer).not.toHaveBeenCalled();
    });

    it('boot starts the tray when the operator already enabled it', () => {
      writeRedlineLinuxEnabled(userData, true);
      const status = make().startIfEnabled();
      expect(status).toEqual({ enabled: true, state: 'running' });
      expect(fake.FakeTray.instances).toHaveLength(1);
    });

    it.each(['darwin', 'win32', 'freebsd'] as const)(
      'never touches electron or the preference on %s',
      (platform) => {
        writeRedlineLinuxEnabled(userData, true);
        const controller = make({ platform });
        expect(controller.startIfEnabled()).toEqual({ enabled: false, state: 'off' });
        expect(controller.enable()).toEqual({ enabled: false, state: 'off' });
        expect(controller.disable()).toEqual({ enabled: false, state: 'off' });
        controller.stop();
        expect(fake.FakeTray.instances).toHaveLength(0);
        expect(fake.createFromBuffer).not.toHaveBeenCalled();
        expect(fake.buildFromTemplate).not.toHaveBeenCalled();
        // A preferência gravada antes não foi sobrescrita.
        expect(readRedlineLinuxEnabled(userData)).toBe(true);
        expect(vi.getTimerCount()).toBe(0);
      },
    );

    it('enable() persists ON and creates exactly one tray, even when called twice', () => {
      const controller = make();
      expect(controller.enable()).toEqual({ enabled: true, state: 'running' });
      expect(controller.enable()).toEqual({ enabled: true, state: 'running' });
      expect(fake.FakeTray.instances).toHaveLength(1);
      expect(readRedlineLinuxEnabled(userData)).toBe(true);
    });

    it('disable() persists OFF, destroys the tray and leaves no timer or watcher', () => {
      const controller = make();
      controller.enable();
      const created = tray();
      expect(controller.disable()).toEqual({ enabled: false, state: 'off' });
      expect(created?.destroyed).toBe(true);
      expect(readRedlineLinuxEnabled(userData)).toBe(false);
      expect(watchers.every((w) => w.closed)).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    });

    it('stop() destroys the tray but keeps the preference (quit is not "hide")', () => {
      const controller = make();
      controller.enable();
      const created = tray();
      controller.stop();
      expect(created?.destroyed).toBe(true);
      expect(readRedlineLinuxEnabled(userData)).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
      // Próximo boot sobe de novo.
      expect(make().startIfEnabled().state).toBe('running');
    });
  });

  describe('missing StatusNotifier host / tray creation failure', () => {
    it('enable() reports unavailable with a reason, does not throw and does not persist ON', () => {
      fake.FakeTray.failWith = new Error('no status icon host');
      const controller = make();
      const status = controller.enable();
      expect(status.enabled).toBe(false);
      expect(status.state).toBe('unavailable');
      expect(status.reason).toContain('no status icon host');
      // Nada é gravado: a falha não vira uma escolha salva.
      expect(existsSync(path.join(userData, REDLINE_LINUX_SETTINGS_FILE))).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    });

    it('logs the failure once, however many times it is retried', () => {
      fake.FakeTray.failWith = new Error('boom');
      const controller = make();
      controller.enable();
      controller.enable();
      controller.startIfEnabled();
      expect(warn).toHaveBeenCalledTimes(1);
    });

    it('a persisted ON with a failing tray reports unavailable (and keeps the preference)', () => {
      writeRedlineLinuxEnabled(userData, true);
      fake.FakeTray.failWith = new Error('dbus down');
      const status = make().startIfEnabled();
      expect(status.enabled).toBe(true);
      expect(status.state).toBe('unavailable');
      expect(status.reason).toContain('dbus down');
      expect(readRedlineLinuxEnabled(userData)).toBe(true);
    });

    it('retrying after the desktop recovers brings the tray up', () => {
      fake.FakeTray.failWith = new Error('not yet');
      const controller = make();
      expect(controller.enable().state).toBe('unavailable');
      fake.FakeTray.failWith = null;
      expect(controller.enable()).toEqual({ enabled: true, state: 'running' });
    });

    it('a menu that fails to build tears the tray down instead of leaving a half-made icon', () => {
      fake.buildFromTemplate.mockImplementationOnce(() => {
        throw new Error('menu exploded');
      });
      const controller = make();
      const status = controller.enable();
      expect(status.state).toBe('unavailable');
      expect(tray()?.destroyed).toBe(true);
    });

    it('enable() undoes the tray when the preference cannot be saved', () => {
      const blocker = path.join(userData, 'blocker');
      writeFileSync(blocker, 'x');
      const status = make({ userDataDir: path.join(blocker, 'sub') }).enable();
      expect(status.state).toBe('unavailable');
      expect(status.reason).toContain('preferência');
      expect(tray()?.destroyed).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    });

    it('truncates a very long error message in the reason', () => {
      fake.FakeTray.failWith = new Error(`x${'y'.repeat(1000)}`);
      const status = make().enable();
      expect((status.reason ?? '').length).toBeLessThan(220);
    });
  });

  describe('what the tray shows', () => {
    it('builds the icon from a PNG at 2x and shows the snapshot in tooltip and menu', () => {
      writeSnapshot(snapshotJson());
      make().enable();
      const [buffer, options] = fake.createFromBuffer.mock.calls[0] as [Buffer, { scaleFactor: number }];
      expect([...buffer.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
      expect(options).toEqual({ scaleFactor: 2 });
      expect(tray()?.tooltip).toBe('Nexus Redline · 1 conta · 62% em Claude Pessoal · agora mesmo');
      const items = menuLabels();
      expect(items[0]).toBe('Redline · pior janela 62% (5h) em Claude Pessoal · atenção');
      expect(items).toContain('  5h ▮▮▮▯▯ 62% · reset em 1h20');
      expect(items).toContain('  semana ▮▮▯▯▯ 40%');
      expect(items.slice(-3)).toEqual(['Abrir cotas no Nexus', '---', 'Ocultar da bandeja']);
    });

    it('info lines are disabled and only the three actions are clickable', () => {
      writeSnapshot(snapshotJson());
      make().enable();
      const template = tray()?.menu?.template ?? [];
      const clickable = template.filter((item) => typeof item.click === 'function').map((i) => i.label);
      expect(clickable).toEqual(['Atualizar agora', 'Abrir cotas no Nexus', 'Ocultar da bandeja']);
      const info = template.filter((i) => i.type !== 'separator' && !i.click && !i.submenu);
      expect(info.length).toBeGreaterThan(0);
      expect(info.every((i) => i.enabled === false)).toBe(true);
    });

    it('escapes & so an account label cannot become a menu accelerator', () => {
      writeSnapshot(snapshotJson({}, 'Claude A&B'));
      make().enable();
      expect(menuLabels().some((l) => l.includes('Claude A&&B'))).toBe(true);
      expect(escapeMenuLabel('a&b && c')).toBe('a&&b &&&& c');
    });

    it('with no snapshot file it shows the waiting state and does not throw', () => {
      make().enable();
      expect(tray()?.tooltip).toContain('aguardando');
      expect(menuLabels()[0]).toBe('Redline · sem dados de cota ainda');
    });

    it('a corrupt snapshot behaves like no snapshot', () => {
      writeSnapshot('{"formatVersion":1,"entries":[');
      make().enable();
      expect(menuLabels()[0]).toBe('Redline · sem dados de cota ainda');
    });

    it('an oversized snapshot is refused without reading it', () => {
      writeSnapshot(snapshotJson({ pad: 'x'.repeat(1_100_000) }));
      make().enable();
      expect(menuLabels()[0]).toBe('Redline · sem dados de cota ainda');
    });

    it.skipIf(process.platform === 'win32')(
      'a FIFO planted in place of the snapshot never hangs the main process',
      () => {
        mkdirSync(path.dirname(snapshotFile()), { recursive: true });
        execFileSync('mkfifo', [snapshotFile()]);
        make().enable();
        expect(menuLabels()[0]).toBe('Redline · sem dados de cota ainda');
      },
    );

    it.skipIf(process.platform === 'win32')(
      'a symlink to an endless device is rejected, not read',
      () => {
        mkdirSync(path.dirname(snapshotFile()), { recursive: true });
        symlinkSync('/dev/zero', snapshotFile());
        make().enable();
        expect(menuLabels()[0]).toBe('Redline · sem dados de cota ainda');
      },
    );

    it('a directory in place of the snapshot is just "no data"', () => {
      mkdirSync(snapshotFile(), { recursive: true });
      make().enable();
      expect(menuLabels()[0]).toBe('Redline · sem dados de cota ainda');
    });

    it('a raw email in the file never reaches the tray', () => {
      writeSnapshot(snapshotJson({}, 'Claude gustavo@gmail.com'));
      make().enable();
      const everything = `${tray()?.tooltip}\n${menuLabels().join('\n')}`;
      expect(everything).not.toContain('gustavo@gmail.com');
    });
  });

  describe('keeping up with the snapshot', () => {
    it('reloads (debounced) when the directory watcher fires', () => {
      writeSnapshot(snapshotJson(), 1_780_000_000);
      make().enable();
      expect(menuLabels()[0]).toContain('62%');
      writeSnapshot(
        snapshotJson({
          entries: [
            {
              id: 'claude:a',
              adapterId: 'claude',
              label: 'Claude Pessoal',
              windows: [{ kind: 'hours', label: '5 Horas', usedRatio: 0.91 }],
              updatedAt: NOW,
            },
          ],
        }),
        1_780_000_100,
      );
      // Rajada de eventos do rename atômico vira UM reload.
      watchers[0].onChange();
      watchers[0].onChange();
      watchers[0].onChange();
      expect(menuLabels()[0]).toContain('62%');
      vi.advanceTimersByTime(REDLINE_LINUX_DEBOUNCE_MS);
      expect(menuLabels()[0]).toContain('91%');
      expect(menuLabels()[0]).toContain('crítico');
    });

    it('falls back to the poll when the watcher cannot start', () => {
      watchShouldThrow = true;
      writeSnapshot(snapshotJson(), 1_780_000_000);
      const controller = make();
      expect(controller.enable().state).toBe('running');
      expect(watchers).toHaveLength(0);
      writeSnapshot(snapshotJson({ updatedAt: NOW }, 'Conta Nova'), 1_780_000_200);
      vi.advanceTimersByTime(REDLINE_LINUX_POLL_MS);
      expect(menuLabels().some((l) => l.includes('Conta Nova'))).toBe(true);
    });

    it('the poll ages the data: a fresh snapshot turns stale without a file change', () => {
      writeSnapshot(snapshotJson());
      make().enable();
      expect(tray()?.tooltip).not.toContain('desatualizada');
      now = NOW + 11 * 60_000;
      vi.advanceTimersByTime(REDLINE_LINUX_POLL_MS);
      expect(tray()?.tooltip).toContain('leitura desatualizada');
    });

    it('does not republish the menu, tooltip or icon when nothing changed', () => {
      writeSnapshot(snapshotJson());
      make().enable();
      const created = tray();
      const before = {
        menu: created?.setContextMenuCalls,
        tip: created?.setToolTipCalls,
        image: created?.setImageCalls,
      };
      vi.advanceTimersByTime(REDLINE_LINUX_POLL_MS * 0.5);
      watchers[0].onChange();
      vi.advanceTimersByTime(REDLINE_LINUX_DEBOUNCE_MS);
      expect({
        menu: created?.setContextMenuCalls,
        tip: created?.setToolTipCalls,
        image: created?.setImageCalls,
      }).toEqual(before);
    });

    it('countdown drift alone republishes the menu at most every 5 minutes', () => {
      writeSnapshot(snapshotJson(), 1_780_000_000);
      make().enable();
      const created = tray();
      const menuCalls = () => created?.setContextMenuCalls ?? 0;
      const first = menuCalls();
      expect(menuLabels()).toContain('  5h ▮▮▮▯▯ 62% · reset em 1h20');
      // 2 min depois: o texto da contagem mudaria ("1h18"), mas o menu aberto
      // do operador não é derrubado por isso.
      now = NOW + 2 * 60_000;
      vi.advanceTimersByTime(REDLINE_LINUX_POLL_MS);
      expect(menuCalls()).toBe(first);
      expect(menuLabels()).toContain('  5h ▮▮▮▯▯ 62% · reset em 1h20');
      // Passados 5 min, o menu é reconstruído com a contagem nova.
      now = NOW + REDLINE_LINUX_MENU_REFRESH_MS + 60_000;
      vi.advanceTimersByTime(REDLINE_LINUX_POLL_MS);
      expect(menuCalls()).toBe(first + 1);
      expect(menuLabels()).toContain('  5h ▮▮▮▯▯ 62% · reset em 1h14');
    });

    it('the tooltip still ages every tick (it never closes anything)', () => {
      writeSnapshot(snapshotJson(), 1_780_000_000);
      make().enable();
      expect(tray()?.tooltip).toContain('agora mesmo');
      now = NOW + 4 * 60_000;
      vi.advanceTimersByTime(REDLINE_LINUX_POLL_MS);
      expect(tray()?.tooltip).toContain('há 4 min');
    });

    it('a snapshot change republishes the menu at once, even inside the 5 min window', () => {
      writeSnapshot(snapshotJson(), 1_780_000_000);
      make().enable();
      const created = tray();
      const before = created?.setContextMenuCalls ?? 0;
      writeSnapshot(snapshotJson({}, 'Conta Trocada'), 1_780_000_300);
      watchers[0].onChange();
      vi.advanceTimersByTime(REDLINE_LINUX_DEBOUNCE_MS);
      expect(created?.setContextMenuCalls).toBe(before + 1);
      expect(menuLabels().some((l) => l.includes('Conta Trocada'))).toBe(true);
    });

    it('re-arms the directory watcher on the poll once it can start again', () => {
      watchShouldThrow = true;
      const controller = make();
      controller.enable();
      expect(watchers).toHaveLength(0);
      watchShouldThrow = false;
      vi.advanceTimersByTime(REDLINE_LINUX_POLL_MS);
      expect(watchers).toHaveLength(1);
      // Não empilha vigias a cada tick.
      vi.advanceTimersByTime(REDLINE_LINUX_POLL_MS * 3);
      expect(watchers).toHaveLength(1);
    });

    it('re-arms after the watcher dies on its own (inotify exhausted, dir removed)', () => {
      const controller = make();
      controller.enable();
      expect(watchers).toHaveLength(1);
      // O vigia real fecha a si mesmo antes de avisar que morreu.
      watchers[0].closed = true;
      watchers[0].onDead();
      vi.advanceTimersByTime(REDLINE_LINUX_POLL_MS);
      expect(watchers).toHaveLength(2);
      controller.disable();
      expect(watchers.every((w) => w.closed)).toBe(true);
    });

    it('swaps the icon only when urgency or staleness changes', () => {
      writeSnapshot(snapshotJson(), 1_780_000_000);
      make().enable();
      const created = tray();
      expect(created?.setImageCalls).toBe(0); // criado com a imagem certa
      now = NOW + 11 * 60_000;
      vi.advanceTimersByTime(REDLINE_LINUX_POLL_MS);
      expect(created?.setImageCalls).toBe(1); // ficou velho: ponto vazado
    });

    it('a snapshot that disappears returns the tray to the waiting state', () => {
      writeSnapshot(snapshotJson());
      make().enable();
      rmSync(snapshotFile());
      vi.advanceTimersByTime(REDLINE_LINUX_POLL_MS);
      expect(menuLabels()[0]).toBe('Redline · sem dados de cota ainda');
    });

    it('survives a poll tick that hits an unreadable file', () => {
      writeSnapshot(snapshotJson(), 1_780_000_000);
      make().enable();
      writeSnapshot('\u0000\u0001\u0002', 1_780_000_500);
      expect(() => vi.advanceTimersByTime(REDLINE_LINUX_POLL_MS)).not.toThrow();
      expect(menuLabels()[0]).toBe('Redline · sem dados de cota ainda');
    });
  });

  describe('menu actions', () => {
    function click(label: string): void {
      const item = tray()?.menu?.template.find((i) => i.label === label);
      expect(item?.click).toBeTypeOf('function');
      item?.click?.();
    }

    it('"Atualizar agora" writes the same refresh signal the other companions write', () => {
      make().enable();
      click('Atualizar agora');
      const signal = path.join(home, '.nexus', 'redline-refresh.request');
      expect(existsSync(signal)).toBe(true);
      expect(readFileSync(signal, 'utf8')).toBe(`{"source":"tray","at":${NOW}}\n`);
    });

    it('the refresh signal body matches the Windows companion byte for byte', () => {
      expect(refreshRequestBody(1_780_000_000_000)).toBe('{"source":"tray","at":1780000000000}\n');
    });

    it('"Atualizar agora" creates ~/.nexus when it does not exist yet', () => {
      expect(existsSync(path.join(home, '.nexus'))).toBe(false);
      make().enable();
      click('Atualizar agora');
      expect(existsSync(path.join(home, '.nexus', 'redline-refresh.request'))).toBe(true);
    });

    it.skipIf(process.platform === 'win32')(
      '"Atualizar agora" never writes through a symlink planted at the signal path',
      () => {
        const victim = path.join(home, 'precious.txt');
        writeFileSync(victim, 'keep me');
        mkdirSync(path.join(home, '.nexus'), { recursive: true });
        symlinkSync(victim, path.join(home, '.nexus', 'redline-refresh.request'));
        make().enable();
        expect(() => click('Atualizar agora')).not.toThrow();
        expect(readFileSync(victim, 'utf8')).toBe('keep me');
        expect(warn).toHaveBeenCalled();
      },
    );

    it.skipIf(process.platform === 'win32')('the refresh signal is private to the user (0600)', () => {
      make().enable();
      click('Atualizar agora');
      const mode = statSync(path.join(home, '.nexus', 'redline-refresh.request')).mode & 0o777;
      expect(mode).toBe(0o600);
    });

    it('"Abrir cotas no Nexus" asks the app to open Uso e cotas', () => {
      make().enable();
      click('Abrir cotas no Nexus');
      expect(openQuota).toHaveBeenCalledTimes(1);
    });

    it('"Ocultar da bandeja" destroys the tray on the next turn and persists OFF', async () => {
      vi.useRealTimers();
      const controller = make();
      controller.enable();
      const created = tray();
      click('Ocultar da bandeja');
      // Ainda dentro do clique: a bandeja não pode ser destruída aqui.
      expect(created?.destroyed).toBe(false);
      await new Promise((resolve) => setImmediate(resolve));
      expect(created?.destroyed).toBe(true);
      expect(readRedlineLinuxEnabled(userData)).toBe(false);
      expect(controller.status()).toEqual({ enabled: false, state: 'off' });
    });

    it('an action that throws does not escape the menu handler', () => {
      openQuota.mockImplementation(() => {
        throw new Error('window gone');
      });
      make().enable();
      expect(() => click('Abrir cotas no Nexus')).not.toThrow();
      expect(warn).toHaveBeenCalled();
    });

    it('a failed refresh write is contained (read-only home)', () => {
      const controller = make({ homedir: path.join(home, 'not-a-dir', 'x') });
      writeFileSync(path.join(home, 'not-a-dir'), 'file in the way');
      controller.enable();
      expect(() => click('Atualizar agora')).not.toThrow();
    });
  });

  describe('tray destroyed from outside / real directory watcher', () => {
    it('a tray the system destroyed is torn down quietly on the next tick', () => {
      writeSnapshot(snapshotJson(), 1_780_000_000);
      const controller = make();
      controller.enable();
      const created = tray();
      if (created) created.destroyed = true;
      expect(() => vi.advanceTimersByTime(REDLINE_LINUX_POLL_MS)).not.toThrow();
      expect(vi.getTimerCount()).toBe(0);
      expect(watchers.every((w) => w.closed)).toBe(true);
      const status = controller.status();
      expect(status.state).toBe('unavailable');
      expect(status.reason).toContain('fechado pelo sistema');
      expect(warn).not.toHaveBeenCalled();
    });

    it('works with the real fs.watch (no injected watcher) and cleans up', () => {
      vi.useRealTimers();
      mkdirSync(path.join(home, '.nexus'), { recursive: true });
      const controller = createRedlineLinuxController({
        userDataDir: userData,
        homedir: home,
        platform: 'linux',
        openQuota,
      });
      expect(controller.enable().state).toBe('running');
      expect(() => controller.disable()).not.toThrow();
      expect(controller.status()).toEqual({ enabled: false, state: 'off' });
    });
  });

  describe('status', () => {
    it('reflects the stored preference even before the tray runs', () => {
      writeRedlineLinuxEnabled(userData, true);
      expect(make().status()).toEqual({ enabled: true, state: 'off' });
    });

    it('is running while the tray exists', () => {
      const controller = make();
      controller.enable();
      expect(controller.status()).toEqual({ enabled: true, state: 'running' });
    });
  });
});
