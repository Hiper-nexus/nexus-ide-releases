import { beforeEach, describe, expect, it, vi } from 'vitest';

const electronMock = vi.hoisted(() => ({
  Menu: {
    buildFromTemplate: vi.fn((template: unknown) => ({ template })),
    setApplicationMenu: vi.fn(),
  },
}));
vi.mock('electron', () => electronMock);

import { buildAppMenuTemplate, installAppMenu } from './app-menu';

type Item = {
  role?: string;
  label?: string;
  accelerator?: string;
  click?: () => void;
  submenu?: Item[];
};

function helpOf(template: Item[]): Item {
  const help = template.find((item) => item.role === 'help');
  if (!help) throw new Error('Ajuda ausente');
  return help;
}

describe('buildAppMenuTemplate', () => {
  it('keeps the standard menus Electron ships by default on macOS', () => {
    const roles = buildAppMenuTemplate({ platform: 'darwin', onReportProblem: vi.fn() }).map(
      (item) => item.role,
    );
    expect(roles).toEqual(['appMenu', 'fileMenu', 'editMenu', 'viewMenu', 'windowMenu', 'help']);
  });

  it('keeps the standard menus on Windows and Linux (no app menu)', () => {
    for (const platform of ['win32', 'linux'] as const) {
      const roles = buildAppMenuTemplate({ platform, onReportProblem: vi.fn() }).map((item) => item.role);
      expect(roles).toEqual(['fileMenu', 'editMenu', 'viewMenu', 'windowMenu', 'help']);
    }
  });

  it('adds "Reportar um problema…" under Ajuda and wires it to the callback', () => {
    const onReportProblem = vi.fn();
    const help = helpOf(buildAppMenuTemplate({ platform: 'linux', onReportProblem }) as Item[]);
    const entry = help.submenu?.find((item) => item.label === 'Reportar um problema…');
    expect(entry).toBeDefined();
    entry?.click?.();
    expect(onReportProblem).toHaveBeenCalledTimes(1);
  });

  it('does not claim a keyboard accelerator (no new shortcut, no conflicts)', () => {
    for (const platform of ['darwin', 'win32', 'linux'] as const) {
      const help = helpOf(buildAppMenuTemplate({ platform, onReportProblem: vi.fn() }) as Item[]);
      for (const item of help.submenu ?? []) expect(item.accelerator).toBeUndefined();
    }
  });
});

describe('installAppMenu', () => {
  beforeEach(() => {
    electronMock.Menu.buildFromTemplate.mockClear();
    electronMock.Menu.setApplicationMenu.mockClear();
  });

  it('builds the template and sets it as the application menu', () => {
    installAppMenu({ platform: 'darwin', onReportProblem: vi.fn() });
    expect(electronMock.Menu.buildFromTemplate).toHaveBeenCalledTimes(1);
    expect(electronMock.Menu.setApplicationMenu).toHaveBeenCalledTimes(1);
    const built = electronMock.Menu.buildFromTemplate.mock.results[0]?.value;
    expect(electronMock.Menu.setApplicationMenu).toHaveBeenCalledWith(built);
  });
});
