/**
 * Testes do shot-bridge-server: política de caminhos (pura) + fluxo HTTP
 * ponta a ponta (sobe o servidor de verdade em 127.0.0.1, faz o handshake
 * exatamente como o cliente Rust do Nexus Shot e verifica ack + evento).
 */

import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  startShotBridgeServer,
  stopShotBridgeServer,
  shotAllowedRoots,
  validateShotIngestFiles,
  buildShotTargetBinding,
  type ShotBridgeServerHandle,
} from './shot-bridge-server';
import type { ShotFileMeta } from '../../shared/shot-bridge';

let home: string;
let userData: string;
let picturesDir: string;
let moviesDir: string;
let handle: ShotBridgeHandleForTest | null = null;
type ShotBridgeHandleForTest = ShotBridgeServerHandle;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'shot-bridge-home-'));
  userData = mkdtempSync(join(tmpdir(), 'shot-bridge-userdata-'));
  picturesDir = join(home, 'Pictures', 'Nexus Shot');
  // Gravações: ~/Movies no macOS; ~\Videos no Windows e ~/Videos no Linux
  // (dirs::video_dir do Shot).
  moviesDir = join(home, process.platform === 'darwin' ? 'Movies' : 'Videos', 'Nexus Shot');
  mkdirSync(picturesDir, { recursive: true });
  mkdirSync(moviesDir, { recursive: true });
});

afterEach(async () => {
  await stopShotBridgeServer();
  handle = null;
  rmSync(home, { recursive: true, force: true });
  rmSync(userData, { recursive: true, force: true });
});

function makeFile(dir: string, name: string, bytes = 4): string {
  const p = join(dir, name);
  writeFileSync(p, Buffer.alloc(bytes, 7));
  return p;
}

describe('validateShotIngestFiles (política de caminhos)', () => {
  it('aceita arquivo sob a raiz permitida e classifica o kind', () => {
    const png = makeFile(picturesDir, 'cap.png');
    const mp4 = makeFile(moviesDir, 'rec.mp4');
    const out = validateShotIngestFiles([png, mp4], { homeDir: home });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.files.map((f) => f.kind)).toEqual(['image', 'video']);
      expect(out.files[0].name).toBe('cap.png');
    }
  });

  it('rejeita caminho fora das raízes (traversal e absoluto arbitrário)', () => {
    const outside = makeFile(home, 'segredo.txt');
    expect(validateShotIngestFiles([outside], { homeDir: home })).toEqual({
      ok: false,
      reason: 'path-outside-allowed',
    });
    expect(
      validateShotIngestFiles([join(picturesDir, '..', '..', 'segredo.txt')], { homeDir: home }),
    ).toEqual({ ok: false, reason: 'path-outside-allowed' });
  });

  it('rejeita symlink que aponta para fora da raiz', () => {
    const outside = makeFile(home, 'fora.png');
    const link = join(picturesDir, 'atalho.png');
    symlinkSync(outside, link);
    expect(validateShotIngestFiles([link], { homeDir: home })).toEqual({
      ok: false,
      reason: 'path-outside-allowed',
    });
  });

  it('rejeita relativo, inexistente, diretório e lista vazia/oversize', () => {
    expect(validateShotIngestFiles(['Pictures/Nexus Shot/x.png'], { homeDir: home })).toEqual({
      ok: false,
      reason: 'path-not-absolute',
    });
    expect(
      validateShotIngestFiles([join(picturesDir, 'nao-existe.png')], { homeDir: home }),
    ).toEqual({ ok: false, reason: 'path-not-found' });
    expect(validateShotIngestFiles([picturesDir], { homeDir: home })).toEqual({
      ok: false,
      reason: 'not-a-file',
    });
    expect(validateShotIngestFiles([], { homeDir: home })).toEqual({
      ok: false,
      reason: 'invalid-shape',
    });
    const tooMany = Array.from({ length: 321 }, (_, i) => join(picturesDir, `f${i}.png`));
    expect(validateShotIngestFiles(tooMany, { homeDir: home })).toEqual({
      ok: false,
      reason: 'too-many-files',
    });
  });
});

describe('raízes e caminhos no Windows', () => {
  it('raízes seguem a pasta de vídeos do SO e as pastas conhecidas', () => {
    expect(shotAllowedRoots('/Users/u', 'darwin')).toEqual([
      '/Users/u/Pictures/Nexus Shot',
      '/Users/u/Movies/Nexus Shot',
    ]);
    expect(shotAllowedRoots('C:\\Users\\u', 'win32')).toEqual([
      'C:\\Users\\u\\Pictures\\Nexus Shot',
      'C:\\Users\\u\\Videos\\Nexus Shot',
    ]);
    // Linux: o padrão XDG é ~/Videos. Antes caía em ~/Movies (regra do macOS)
    // e a gravação do Shot só era aceita por acaso, via knownFolders.
    expect(shotAllowedRoots('/home/u', 'linux')).toEqual([
      '/home/u/Pictures/Nexus Shot',
      '/home/u/Videos/Nexus Shot',
    ]);
    // Pastas XDG personalizadas (user-dirs.dirs) entram pelas pastas conhecidas.
    expect(
      shotAllowedRoots('/home/u', 'linux', {
        pictures: '/home/u/Imagens',
        videos: '/home/u/Vídeos',
      }),
    ).toEqual([
      '/home/u/Pictures/Nexus Shot',
      '/home/u/Videos/Nexus Shot',
      '/home/u/Imagens/Nexus Shot',
      '/home/u/Vídeos/Nexus Shot',
    ]);
    // Imagens redirecionada ao OneDrive entra; a pasta padrão repetida não
    // duplica.
    expect(
      shotAllowedRoots('C:\\Users\\u', 'win32', {
        pictures: 'C:\\Users\\u\\OneDrive\\Imagens',
        videos: 'C:\\Users\\u\\Videos',
      }),
    ).toEqual([
      'C:\\Users\\u\\Pictures\\Nexus Shot',
      'C:\\Users\\u\\Videos\\Nexus Shot',
      'C:\\Users\\u\\OneDrive\\Imagens\\Nexus Shot',
    ]);
  });

  it('no Windows aceita só letra de unidade — UNC e device paths não', () => {
    const opts = {
      platform: 'win32' as const,
      homeDir: 'C:\\Users\\u',
      realpathFn: (p: string) => p,
    };
    for (const raw of [
      '\\\\host\\share\\Pictures\\Nexus Shot\\x.png',
      '\\\\?\\C:\\Users\\u\\Pictures\\Nexus Shot\\x.png',
      '\\\\.\\C:\\Users\\u\\Pictures\\Nexus Shot\\x.png',
      '/Users/u/Pictures/Nexus Shot/x.png',
      'Pictures\\Nexus Shot\\x.png',
    ]) {
      expect(validateShotIngestFiles([raw], opts), raw).toEqual({
        ok: false,
        reason: 'path-not-absolute',
      });
    }
  });

  it('aceita a pasta conhecida redirecionada fora da home', () => {
    const redirected = mkdtempSync(join(tmpdir(), 'shot-bridge-onedrive-'));
    try {
      const dir = join(redirected, 'Nexus Shot');
      mkdirSync(dir, { recursive: true });
      const png = makeFile(dir, 'cap.png');
      expect(validateShotIngestFiles([png], { homeDir: home }).ok).toBe(false);
      expect(
        validateShotIngestFiles([png], { homeDir: home, knownFolders: { pictures: redirected } }).ok,
      ).toBe(true);
    } finally {
      rmSync(redirected, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform === 'win32')('no Windows compara a raiz sem diferenciar caixa', () => {
    const png = makeFile(picturesDir, 'cap.png');
    expect(validateShotIngestFiles([png.toUpperCase()], { homeDir: home }).ok).toBe(true);
  });
});

describe('servidor HTTP (handshake ponta a ponta)', () => {
  async function startWithCapture(): Promise<{ received: ShotFileMeta[][] }> {
    const received: ShotFileMeta[][] = [];
    handle = await startShotBridgeServer({
      userDataPath: userData,
      homeDir: home,
      onFiles: (files) => received.push(files),
    });
    return { received };
  }

  function post(
    body: string,
    token?: string,
  ): Promise<{ status: number; json: { ok: boolean; received?: number; reason?: string } }> {
    return fetch(`http://127.0.0.1:${handle!.port}/shot/ingest`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { 'x-nexus-shot-token': token } : {}),
      },
      body,
    }).then(async (res) => ({ status: res.status, json: await res.json() }));
  }

  it('grava endpoint.json com port+token (modo 0600) e limpa ao fechar', async () => {
    await startWithCapture();
    const raw = JSON.parse(readFileSync(handle!.endpointFilePath, 'utf8')) as {
      port: number;
      token: string;
    };
    expect(raw.port).toBe(handle!.port);
    expect(raw.token).toBe(handle!.token);
    expect(existsSync(handle!.endpointFilePath)).toBe(true);
    await handle!.close();
    handle = null;
    expect(existsSync(join(userData, 'shot-bridge', 'endpoint.json'))).toBe(false);
  });

  it('aceita ingest válido do Shot e dispara onFiles (smoke e2e)', async () => {
    const { received } = await startWithCapture();
    const png = makeFile(picturesDir, 'captura.png');
    // Handshake exatamente como o cliente Rust: type/source + token no header.
    const res = await post(
      JSON.stringify({ type: 'ingest', files: [png], source: 'nexus-shot' }),
      handle!.token,
    );
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ ok: true, received: 1 });
    expect(received).toHaveLength(1);
    expect(received[0][0].name).toBe('captura.png');
    expect(received[0][0].kind).toBe('image');
  });

  it('rejeita arquivo fora das raízes permitidas via HTTP', async () => {
    const { received } = await startWithCapture();
    const outside = makeFile(home, 'etc-passwd-copia.txt');
    const res = await post(
      JSON.stringify({ type: 'ingest', files: [outside], source: 'nexus-shot' }),
      handle!.token,
    );
    expect(res.status).toBe(400);
    expect(res.json).toEqual({ ok: false, reason: 'path-outside-allowed' });
    expect(received).toHaveLength(0);
  });

  it('rejeita sem token, com token errado, shape inválido e JSON quebrado', async () => {
    await startWithCapture();
    const png = makeFile(picturesDir, 'a.png');
    expect((await post(JSON.stringify({ type: 'ingest', files: [png], source: 'nexus-shot' }))).status).toBe(401);
    expect(
      (await post(JSON.stringify({ type: 'ingest', files: [png], source: 'nexus-shot' }), 'deadbeef')).status,
    ).toBe(401);
    expect(
      (await post(JSON.stringify({ type: 'other', files: [png], source: 'nexus-shot' }), handle!.token)).json,
    ).toEqual({ ok: false, reason: 'invalid-shape' });
    expect((await post('{nao-json', handle!.token)).json).toEqual({
      ok: false,
      reason: 'invalid-json',
    });
  });
});


describe('explicit Shot destination (F-1054)', () => {
  it('protects targets with the token and roundtrips a selected target through real HTTP', async () => {
    const received: Array<{ files: ShotFileMeta[]; targetPaneId?: string; targetBinding?: import('../../shared/shot-bridge').ShotTargetBinding }> = [];
    handle = await startShotBridgeServer({
      userDataPath: userData, homeDir: home,
      listTargets: () => ({ missions: [{ id: 'operator', title: 'Panes', panes: [
        { id: 'pane-selected', title: 'Codex', focused: false },
      ] }] }),
      resolveTargetBinding: paneId => ({ paneId, sessionId: 'session-selected', workspacePath: '/fixture-workspace' }),
      onFiles: (files, targetPaneId, targetBinding) => received.push({ files, targetPaneId, targetBinding }),
    });
    const url = `http://127.0.0.1:${handle.port}`;
    for (const token of [undefined, 'deadbeef']) {
      expect((await fetch(`${url}/shot/targets`, { headers: token ? { 'x-nexus-shot-token': token } : {} })).status).toBe(401);
    }
    const headers = { 'x-nexus-shot-token': handle.token, 'content-type': 'application/json' };
    const query = await fetch(`${url}/shot/targets`, { headers });
    expect(query.status).toBe(200);
    const targets = await query.json();
    expect(targets).toEqual({ ok: true, data: { missions: [{ id: 'operator', title: 'Panes', panes: [
      { id: 'pane-selected', title: 'Codex', focused: false },
    ] }] } });
    const png = makeFile(picturesDir, 'capture.png');
    for (const destination of [{ targetPaneId: targets.data.missions[0].panes[0].id }, { target: { paneId: 'pane-selected' } },
      { targetPaneId: 'pane-selected', targetBinding: { paneId: 'pane-selected', sessionId: 'forged-session', workspacePath: '/forged-workspace' } }]) {
      const sent = await fetch(`${url}/shot/ingest`, { method: 'POST', headers,
        body: JSON.stringify({ type: 'ingest', source: 'nexus-shot', files: [png], ...destination }) });
      expect(sent.status).toBe(200);
      expect(await sent.json()).toEqual({ ok: true, received: 1 });
    }
    expect(received).toHaveLength(3);
    expect(received[0].targetPaneId).toBe('pane-selected');
    expect(received[1].targetPaneId).toBe('pane-selected');
    expect(received[0].targetBinding).toEqual({ paneId: 'pane-selected', sessionId: 'session-selected', workspacePath: '/fixture-workspace' });
    expect(received[2].targetBinding).toEqual(received[0].targetBinding);
    expect(received[0].files[0].path).toBe(realpathSync(png));
    for (const destination of [
      { targetPaneId: '' }, { targetPaneId: null }, { targetPaneId: 4 },
      { targetPaneId: 'a'.repeat(129) }, { targetPaneId: 'pane\nother' },
      { target: {} }, { target: 'pane-selected' },
      { targetPaneId: 'pane-selected', target: { paneId: 'pane-other' } },
    ]) {
      const sent = await fetch(`${url}/shot/ingest`, { method: 'POST', headers,
        body: JSON.stringify({ type: 'ingest', source: 'nexus-shot', files: [png], ...destination }) });
      expect(sent.status).toBe(400);
      expect(await sent.json()).toEqual({ ok: false, reason: 'invalid-shape' });
    }
    const stale = await fetch(`${url}/shot/ingest`, { method: 'POST', headers,
      body: JSON.stringify({ type: 'ingest', source: 'nexus-shot', files: [png], targetPaneId: 'pane-gone' }) });
    expect(stale.status).toBe(400);
    expect(await stale.json()).toEqual({ ok: false, reason: 'target-unavailable' });
    expect(received).toHaveLength(3);
  });

  it('bounds and sanitizes target IDs/titles/counts without exposing extra fields', async () => {
    handle = await startShotBridgeServer({ userDataPath: userData, homeDir: home, onFiles: () => {},
      listTargets: () => ({ missions: Array.from({ length: 30 }, (_, i) => ({
        id: `mission-${i}`, title: 'M\n'.repeat(100), token: 'private',
        panes: [ { id: 'invalid\u0000', title: 'bad' }, { id: 'x'.repeat(129) },
          ...Array.from({ length: 60 }, (_, j) => ({ id: `pane-${i}-${j}`, title: 'P\u001b'.repeat(100), focused: true, token: 'private' })) ],
      })) }),
    });
    const response = await fetch(`http://127.0.0.1:${handle.port}/shot/targets`, { headers: { 'x-nexus-shot-token': handle.token } });
    const result = await response.json();
    expect(result.data.missions.length).toBeLessThanOrEqual(25);
    for (const mission of result.data.missions) {
      expect(mission.title.length).toBeLessThanOrEqual(80);
      expect(mission.title).not.toMatch(/[\u0000-\u001f\u007f]/);
      expect(mission.panes.length).toBeLessThanOrEqual(50);
      for (const pane of mission.panes) {
        expect(pane.id.length).toBeLessThanOrEqual(128);
        expect(pane.id).not.toMatch(/[\u0000-\u001f\u007f]/);
        expect(pane.title.length).toBeLessThanOrEqual(80);
        expect(pane.title).not.toMatch(/[\u0000-\u001f\u007f]/);
        expect(pane.focused).toBe(false);
      }
    }
    expect(JSON.stringify(result)).not.toContain('private');
  });
});

it('mints the binding only for the unique live physical session in the coordination workspace', () => {
  const scope = { projectId: 'project', checkoutId: 'checkout', rootRealPath: '/coordination' };
  const agent = { paneId: 'pane-a', sessionId: 'session-a', kind: 'cli-agent',
    scope: { ...scope, rootRealPath: '/writer-worktree' }, coordinationScope: scope };
  expect(buildShotTargetBinding([agent], scope, new Set(['session-a']), 'pane-a')).toEqual({
    paneId: 'pane-a', sessionId: 'session-a', workspacePath: '/coordination',
  });
  for (const sessions of [[agent, agent], [{ ...agent, state: 'parked' }],
    [{ ...agent, coordinationScope: { ...scope, checkoutId: 'foreign' } }]]) {
    expect(buildShotTargetBinding(sessions, scope, new Set(['session-a']), 'pane-a')).toBeNull();
  }
  expect(buildShotTargetBinding([agent], scope, new Set(), 'pane-a')).toBeNull();
  expect(buildShotTargetBinding([agent], null, new Set(['session-a']), 'pane-a')).toBeNull();
});


describe('Main physical Shot target inventory', () => {
  it('includes only the current coordination scope, groups missions, omits ambiguous panes', async () => {
    const { buildShotTargets } = await import('./shot-bridge-server');
    const scope = { projectId: 'project', checkoutId: 'checkout', rootRealPath: '/a' };
    const agent = { paneId: 'pane-a', sessionId: 'session-a', kind: 'cli-agent', adapterId: 'codex', scope };
    expect(buildShotTargets([
      agent,
      { ...agent, paneId: 'pane-worktree', scope: { ...scope, rootRealPath: '/worktree' }, coordinationScope: scope, missionId: 'mission-1', immediateMissionTitle: 'Mission' },
      { ...agent, paneId: 'pane-foreign', scope: { ...scope, checkoutId: 'other' } },
      { ...agent, paneId: undefined },
      { ...agent, paneId: 'pane-ambiguous' }, { ...agent, paneId: 'pane-ambiguous' },
      { paneId: 'pane-shell', sessionId: 'session-shell', kind: 'shell', title: 'Shell', scope },
      { ...agent, paneId: 'pane-dead', sessionId: 'session-dead' },
      { ...agent, paneId: 'pane-parked', state: 'parked' },
      { ...agent, paneId: 'pane-exited', state: 'exited' },
      { ...agent, paneId: 'pane-hibernated', state: 'hibernated' },
      { ...agent, paneId: 'pane-browser', kind: 'browser' },
    ], scope, new Set(['session-a', 'session-shell']))).toEqual({ missions: [
      { id: 'operator', title: 'Panes', panes: [{ id: 'pane-a', title: 'codex', focused: false }, { id: 'pane-shell', title: 'Shell', focused: false }] },
      { id: 'mission-1', title: 'Mission', panes: [{ id: 'pane-worktree', title: 'codex', focused: false }] },
    ] });
    expect(buildShotTargets([agent], null, new Set(['session-a']))).toEqual({ missions: [] });
  });
});


it('local HTTP query → selected capture → Main event → staged renderer batch stays on that target', async () => {
  const { initShotIngestToasts } = await import('../../renderer/state/shot-ingest');
  const { useToastStore } = await import('../../renderer/state/toast-store');
  let emit: ((payload: import('../../shared/shot-bridge').ShotFilesReceivedPayload) => void) | undefined;
  const writes: Array<[string, string]> = [];
  const imports: string[] = [];
  const off = initShotIngestToasts({
    onShotFilesReceived: callback => { emit = callback; return () => { emit = undefined; }; },
    openTerminalPath: async () => ({ ok: true }),
    resolveTargetPaneId: requested => requested === 'pane-selected' ? requested : 'pane-focused',
    getPaneSessionId: () => 'session-selected',
    getActiveWorkspacePath: () => '/fixture-workspace',
    writeToPane: (paneId, data) => { writes.push([paneId, data]); return true; },
    files: { importDroppedUri: async uri => { imports.push(uri); return { ok: true, path: `.nexus/attachments/mission-context/capture-${imports.length}.png` }; } },
  });
  try {
    handle = await startShotBridgeServer({ userDataPath: userData, homeDir: home,
      listTargets: () => ({ missions: [{ id: 'operator', title: 'Panes', panes: [{ id: 'pane-selected', title: 'Codex', focused: false }] }] }),
      resolveTargetBinding: paneId => ({ paneId, sessionId: 'session-selected', workspacePath: '/fixture-workspace' }),
      onFiles: (files, targetPaneId, targetBinding) => emit?.({ files, source: 'nexus-shot', receivedAt: Date.now(), ...(targetPaneId ? { targetPaneId, targetBinding } : {}) }),
    });
    const headers = { 'x-nexus-shot-token': handle.token, 'content-type': 'application/json' };
    const url = `http://127.0.0.1:${handle.port}`;
    const query = await (await fetch(`${url}/shot/targets`, { headers })).json();
    const files = [makeFile(moviesDir, 'recording.mp4'), makeFile(picturesDir, 'contact-sheet.png'),
      ...Array.from({ length: 5 }, (_, i) => makeFile(picturesDir, `frame-${i}.png`))];
    const response = await fetch(`${url}/shot/ingest`, { method: 'POST', headers,
      body: JSON.stringify({ type: 'ingest', source: 'nexus-shot', files, target: { paneId: query.data.missions[0].panes[0].id } }) });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, received: 7 });
    expect(writes).toHaveLength(1);
    expect(writes[0][0]).toBe('pane-selected');
    expect(writes[0][1]).toBe('/fixture-workspace/.nexus/attachments/mission-context/capture-1.png /fixture-workspace/.nexus/attachments/mission-context/capture-2.png /fixture-workspace/.nexus/attachments/mission-context/capture-3.png ');
    expect(writes[0][1]).not.toMatch(/[\r\n]/);
    expect(imports).toHaveLength(3);
    expect(imports[0]).toContain('contact-sheet.png');
    expect(imports[1]).toContain('recording.mp4');
    expect(imports[2]).toContain('frame-0.png');
  } finally {
    off();
    for (const toast of useToastStore.getState().toasts) useToastStore.getState().dismiss(toast.id);
  }
});


it('a failed targets provider responds with a generic bounded error', async () => {
  handle = await startShotBridgeServer({ userDataPath: userData, homeDir: home, onFiles: () => {},
    listTargets: () => { throw new Error('private-provider-title'); } });
  const response = await fetch(`http://127.0.0.1:${handle.port}/shot/targets`, {
    headers: { 'x-nexus-shot-token': handle.token }, signal: AbortSignal.timeout(500),
  });
  expect(response.status).toBe(500);
  expect(await response.json()).toEqual({ ok: false, reason: 'internal' });
});

it.each(['session', 'workspace'] as const)('explicit Shot destination refuses a %s change before the Main event reaches the renderer', async change => {
  const { initShotIngestToasts } = await import('../../renderer/state/shot-ingest');
  const { useToastStore } = await import('../../renderer/state/toast-store');
  type Payload = import('../../shared/shot-bridge').ShotFilesReceivedPayload;
  let emit: ((payload: Payload) => void | Promise<void>) | undefined;
  let pending: Payload | undefined;
  let session = 'session-selected';
  let workspace = '/fixture-workspace';
  const imports: string[] = [], writes: string[] = [];
  const off = initShotIngestToasts({
    onShotFilesReceived: callback => { emit = callback; return () => { emit = undefined; }; },
    openTerminalPath: async () => ({ ok: true }),
    resolveTargetPaneId: requested => requested === 'pane-selected' ? requested : 'pane-focused',
    getPaneSessionId: () => session,
    getActiveWorkspacePath: () => workspace,
    writeToPane: (_paneId, data) => { writes.push(data); return true; },
    files: { importDroppedUri: async uri => { imports.push(uri); return { ok: true, path: '.nexus/attachments/capture.png' }; } },
  });
  try {
    handle = await startShotBridgeServer({ userDataPath: userData, homeDir: home,
      listTargets: () => ({ missions: [{ id: 'operator', title: 'Panes', panes: [{ id: 'pane-selected', title: 'Codex', focused: false }] }] }),
      resolveTargetBinding: paneId => buildShotTargetBinding([{ paneId, kind: 'cli-agent', sessionId: session,
        scope: { projectId: 'project-a', checkoutId: 'checkout-a', rootRealPath: workspace } }],
      { projectId: 'project-a', checkoutId: 'checkout-a', rootRealPath: workspace }, new Set([session]), paneId),
      onFiles: (files, targetPaneId, targetBinding) => { pending = { files, source: 'nexus-shot', receivedAt: Date.now(), targetPaneId, targetBinding }; },
    });
    const response = await fetch(`http://127.0.0.1:${handle.port}/shot/ingest`, {
      method: 'POST', headers: { 'x-nexus-shot-token': handle.token, 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'ingest', source: 'nexus-shot', files: [makeFile(picturesDir, 'capture.png')], targetPaneId: 'pane-selected' }),
    });
    expect(response.status).toBe(200);
    expect(pending?.targetPaneId).toBe('pane-selected');
    if (change === 'session') session = 'session-replacement';
    else workspace = '/another-workspace';
    await emit!(pending!);
    expect(imports, 'the prior validated destination must be checked before the first file copy').toHaveLength(0);
    expect(writes).toHaveLength(0);
    expect(useToastStore.getState().toasts.some(toast => toast.title === 'Não deu para colar a captura no pane escolhido')).toBe(true);
  } finally {
    off();
    for (const toast of useToastStore.getState().toasts) useToastStore.getState().dismiss(toast.id);
  }
});
