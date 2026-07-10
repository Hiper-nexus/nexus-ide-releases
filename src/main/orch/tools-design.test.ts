import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserDesignEvent } from '../../shared/browser-design';

const stubs = vi.hoisted(() => ({
  authorizePaneRef: vi.fn(),
  resolveCwdForScope: vi.fn<(_scope: unknown, value?: string) => string>(),
  captureBrowserScreenshot: vi.fn(),
}));

vi.mock('./tool-util', async (importOriginal) => {
  const original = await importOriginal<typeof import('./tool-util')>();
  return { ...original, authorizePaneRef: stubs.authorizePaneRef };
});
vi.mock('./workspace-path', () => ({
  resolveCwdForScope: stubs.resolveCwdForScope,
}));
vi.mock('../browser/browser-manager', () => ({
  browserDesignSessionKey: (_scope: unknown, paneId: string) => paneId,
  captureBrowserScreenshot: stubs.captureBrowserScreenshot,
}));

import {
  ingestDesignEvent,
  prepareDesignModeTransition,
  resetDesignSessionsForTest,
} from '../browser/design-session';
import { buildDesignTools } from './tools-design';

const SCOPE = {
  version: 1,
  installationId: 'installation-test',
  projectId: 'project-test',
  checkoutId: 'checkout-test',
  rootRealPath: '/tmp/project-test',
  identitySource: 'provisional',
} as const;
const CTX = { role: 'user', label: 'test', scope: SCOPE } as never;
const GENERATION = '6e8a1b53-0f9c-4a2d-9e8f-1a2b3c4d5e6f';

function selectionEvent(): BrowserDesignEvent {
  return {
    eventId: '7f9b2c64-1a2b-4c3d-8e9f-0a1b2c3d4e5f',
    generation: GENERATION,
    type: 'selection',
    at: 1_700_000_000_000,
    selection: {
      ref: 'e1',
      tag: 'button',
      id: 'save',
      classes: ['btn-primary'],
      selector: '#save',
      rect: { x: 12, y: 34, width: 120, height: 40 },
      text: 'Salvar',
      outerHtml: '<button id="save">Salvar</button>',
      attributes: { id: 'save' },
      computedStyles: { display: 'inline-block' },
      url: 'http://localhost:5173/',
      frameworkHints: {
        framework: 'react',
        componentName: 'SaveButton',
        ownerChain: ['SaveButton', 'App'],
      },
    },
  };
}

function ingestSelection(paneId: string): void {
  prepareDesignModeTransition(paneId, GENERATION, true);
  ingestDesignEvent(paneId, {
    eventId: '7f9b2c64-1a2b-4c3d-8e9f-0a1b2c3d4e60',
    generation: GENERATION,
    type: 'mode',
    at: 1_700_000_000_000,
    mode: { active: true, reason: 'enable' },
  });
  ingestDesignEvent(paneId, selectionEvent());
}

let workspace = '';

beforeEach(() => {
  vi.resetAllMocks();
  resetDesignSessionsForTest();
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-design-tool-'));
  stubs.resolveCwdForScope.mockReturnValue(workspace);
});

afterEach(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
});

function getTool() {
  const tool = buildDesignTools().find(
    (item) => item.name === 'nexus_design_selection_get',
  );
  expect(tool).toBeDefined();
  return tool!;
}

describe('nexus_design_selection_get', () => {
  it('returns the selection plus workspace candidates for the pane', async () => {
    fs.mkdirSync(path.join(workspace, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(workspace, 'src', 'SaveButton.tsx'),
      'export function SaveButton() { return <button className="btn-primary" />; }',
    );
    ingestSelection('pane-browser');

    const result = (await getTool().handler({ paneId: 'pane-browser' }, CTX)) as {
      paneId: string;
      selection: { ref: string; frameworkHints?: { componentName?: string } };
      candidates: Array<{ file: string; line: number; score: number }>;
    };
    expect(result.paneId).toBe('pane-browser');
    expect(result.selection.ref).toBe('e1');
    expect(result.selection.frameworkHints?.componentName).toBe('SaveButton');
    expect(result.candidates.length).toBeGreaterThan(0);
    expect(result.candidates[0].file).toBe(path.join('src', 'SaveButton.tsx'));
    expect(stubs.authorizePaneRef).toHaveBeenCalledWith(CTX, 'pane-browser', 'read');
  });

  it('fails with a clear error when there is no selection', async () => {
    await expect(getTool().handler({ paneId: 'pane-x' }, CTX)).rejects.toThrow(
      /design/i,
    );
  });

  it('propagates authorization denials without touching state', async () => {
    stubs.authorizePaneRef.mockImplementation(() => {
      throw new Error('not authorized: mission confinement');
    });
    ingestSelection('pane-browser');
    await expect(
      getTool().handler({ paneId: 'pane-browser' }, CTX),
    ).rejects.toThrow(/not authorized/);
    expect(stubs.captureBrowserScreenshot).not.toHaveBeenCalled();
  });

  it('captures an element screenshot only when asked, clipped to the rect', async () => {
    ingestSelection('pane-browser');
    stubs.captureBrowserScreenshot.mockResolvedValue({
      paneId: 'pane-browser',
      path: '/tmp/shot.png',
      width: 120,
      height: 40,
      url: 'http://localhost:5173/',
      title: 'app',
      capturedAt: 1,
    });

    const withoutShot = (await getTool().handler({ paneId: 'pane-browser' }, CTX)) as {
      screenshot?: unknown;
    };
    expect(withoutShot.screenshot).toBeUndefined();
    expect(stubs.captureBrowserScreenshot).not.toHaveBeenCalled();

    const withShot = (await getTool().handler(
      { paneId: 'pane-browser', includeScreenshot: true },
      CTX,
    )) as { screenshot?: { path: string } };
    expect(withShot.screenshot?.path).toBe('/tmp/shot.png');
    expect(stubs.captureBrowserScreenshot).toHaveBeenCalledWith(
      'pane-browser',
      SCOPE,
      undefined,
      { clip: { x: 12, y: 34, width: 120, height: 40 } },
    );
  });

  it('screenshot failures degrade the result instead of failing the tool', async () => {
    ingestSelection('pane-browser');
    stubs.captureBrowserScreenshot.mockRejectedValue(new Error('pane hidden'));
    const result = (await getTool().handler(
      { paneId: 'pane-browser', includeScreenshot: true },
      CTX,
    )) as { screenshot?: unknown; selection: unknown };
    expect(result.selection).toBeDefined();
    expect(result.screenshot).toBeUndefined();
  });
});
