import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerPreviewCdpBridge } from './preview-cdp-bridge';
import { authorizePaneAccess, type PaneAuthzInfo } from './pane-authz';
import { testProjectScope } from './__tests__/scope-fixture';
import {
  authorizedPreviewCdpUrl,
  isRunningPreviewUrl,
  isRunningPreviewUrlForScope,
  listPreviews,
  startPreview,
  stopAllPreviews,
  stopPreview,
  stopPreviewWithProof,
} from './preview-server';

const scopeA = { projectId: 'project-a', checkoutId: 'checkout-a' };
const scopeB = { projectId: 'project-b', checkoutId: 'checkout-b' };

let dir: string;
let outsideDir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-preview-'));
  outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-preview-outside-'));
  fs.writeFileSync(path.join(dir, 'index.html'), '<h1>preview ok</h1>');
  fs.writeFileSync(path.join(dir, 'app.js'), 'console.log(1)');
});

afterEach(() => {
  registerPreviewCdpBridge(null);
  stopAllPreviews();
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(outsideDir, { recursive: true, force: true });
});

describe('preview-server', () => {
  it('binds direct-write preview trust to the exact project scope and canonical root', async () => {
    const preview = await startPreview(dir, scopeA);
    const executionScope = {
      version: 1 as const,
      installationId: 'installation-a',
      ...scopeA,
      rootRealPath: dir,
      identitySource: 'manifest' as const,
    };
    expect(isRunningPreviewUrlForScope(preview.url, executionScope)).toBe(true);
    expect(
      isRunningPreviewUrlForScope(preview.url, {
        ...executionScope,
        projectId: scopeB.projectId,
        checkoutId: scopeB.checkoutId,
      }),
    ).toBe(false);
    expect(
      isRunningPreviewUrlForScope(preview.url, {
        ...executionScope,
        rootRealPath: outsideDir,
      }),
    ).toBe(false);
  });

  it('serve index.html com content-type e é idempotente por diretório', async () => {
    const first = await startPreview(dir, scopeA);
    const second = await startPreview(dir, scopeA);
    expect(second.id).toBe(first.id);
    expect(second.port).toBe(first.port);
    expect(second.cdpTicket).toBe(first.cdpTicket);

    const res = await fetch(first.url);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(await res.text()).toContain('preview ok');

    const js = await fetch(`${first.url}app.js`);
    expect(js.headers.get('content-type')).toContain('javascript');
  });

  it('coalesces concurrent starts for the same project checkout and directory', async () => {
    const [first, second] = await Promise.all([
      startPreview(dir, scopeA),
      startPreview(dir, scopeA),
    ]);

    expect(second.id).toBe(first.id);
    expect(second.port).toBe(first.port);
    expect(listPreviews(scopeA)).toHaveLength(1);
  });

  it('does not retain a listener when authority is revoked at bind completion', async () => {
    let checkpoints = 0;
    await expect(
      startPreview(dir, scopeA, {
        assertCurrentAuthority: () => {
          checkpoints += 1;
          if (checkpoints >= 3) throw new Error('session_authority_revoked');
        },
      }),
    ).rejects.toThrow(/session_authority_revoked/);

    expect(listPreviews(scopeA)).toEqual([]);
  });

  it('bloqueia path traversal para fora da raiz', async () => {
    const { url } = await startPreview(dir, scopeA);
    const res = await fetch(`${url}..%2f..%2f..%2fetc%2fpasswd`);
    expect([403, 404]).toContain(res.status);
    const res2 = await fetch(`${url}%2e%2e/%2e%2e/etc/passwd`);
    expect([403, 404]).toContain(res2.status);
  });

  it('bloqueia symlink dentro da raiz que aponta para arquivo externo', async () => {
    const secret = 'segredo-fora-da-raiz';
    const secretPath = path.join(outsideDir, 'secret.txt');
    fs.writeFileSync(secretPath, secret);
    fs.symlinkSync(secretPath, path.join(dir, 'leak.txt'));

    const { url } = await startPreview(dir, scopeA);
    const res = await fetch(`${url}leak.txt`);

    expect(res.status).toBe(403);
    expect(await res.text()).not.toContain(secret);
  });

  it('404 para arquivo inexistente e 405 para métodos de escrita', async () => {
    const { url } = await startPreview(dir, scopeA);
    expect((await fetch(`${url}nada.css`)).status).toBe(404);
    expect((await fetch(url, { method: 'POST', body: 'x' })).status).toBe(405);
  });

  it('stop encerra e some da listagem', async () => {
    const preview = await startPreview(dir, scopeA);
    expect(preview.id).not.toContain(dir);
    expect(listPreviews(scopeA)).toHaveLength(1);
    expect(isRunningPreviewUrl(`${preview.url}nested/page`)).toBe(true);
    expect(isRunningPreviewUrl(`http://127.0.0.1:${preview.port + 1}/`)).toBe(false);
    expect(stopPreview(preview.id, scopeB)).toBe(false);
    expect(stopPreview(preview.id, scopeA)).toBe(true);
    expect(isRunningPreviewUrl(preview.url)).toBe(false);
    expect(listPreviews(scopeA)).toHaveLength(0);
    expect(stopPreview(preview.id, scopeA)).toBe(false);
  });

  it('stops by opaque id after the original directory is deleted and recreated', async () => {
    const preview = await startPreview(dir, scopeA);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'index.html'), '<h1>replacement</h1>');

    expect(stopPreview(preview.id, scopeA)).toBe(true);
    expect(listPreviews(scopeA)).toEqual([]);
  });

  it('waits for physical listener close proof for privileged review teardown', async () => {
    const preview = await startPreview(dir, scopeA);

    await expect(
      stopPreviewWithProof(preview.id, scopeB),
    ).resolves.toBe(false);
    await expect(
      stopPreviewWithProof(preview.id, scopeA),
    ).resolves.toBe(true);

    expect(listPreviews(scopeA)).toEqual([]);
    await expect(fetch(preview.url)).rejects.toThrow();
  });

  it('coalesces concurrent privileged teardown onto one physical close', async () => {
    const preview = await startPreview(dir, scopeA);

    await expect(
      Promise.all([
        stopPreviewWithProof(preview.id, scopeA),
        stopPreviewWithProof(preview.id, scopeA),
      ]),
    ).resolves.toEqual([true, true]);
    expect(listPreviews(scopeA)).toEqual([]);
  });

  it('recusa caminho que não é diretório', async () => {
    await expect(
      startPreview(path.join(dir, 'index.html'), scopeA),
    ).rejects.toThrow();
  });

  it('feeds the preview socket into the pane relay and detaches on close', async () => {
    const received: string[] = [];
    const writers: Array<(message: string) => void> = [];
    const opened: Array<{
      projectId: string;
      checkoutId: string;
      paneId: string;
      origin: string;
    }> = [];
    let detached = 0;
    registerPreviewCdpBridge({
      open: (scope, paneId, origin, write) => {
        opened.push({
          projectId: scope.projectId,
          checkoutId: scope.checkoutId,
          paneId,
          origin,
        });
        writers.push(write);
        return {
          connection: {
            receive: (raw) => {
              received.push(raw);
            },
          },
          detach: () => {
            detached += 1;
          },
        };
      },
      solePaneId: () => 'pane-preview',
    });
    const preview = await startPreview(dir, scopeA);
    const discovery = await fetch(new URL('/json/version', preview.url));
    expect(discovery.status).toBe(200);
    const advertised = (await discovery.json()) as { webSocketDebuggerUrl: string };
    expect(advertised.webSocketDebuggerUrl).toBe(
      `ws://127.0.0.1:${preview.port}/cdp/pane-preview`,
    );

    const ws = new WebSocket(
      `ws://127.0.0.1:${preview.port}/cdp/pane-preview?ticket=${encodeURIComponent(preview.cdpTicket)}&projectId=other`,
    );
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
    expect(opened).toEqual([
      {
        projectId: scopeA.projectId,
        checkoutId: scopeA.checkoutId,
        paneId: 'pane-preview',
        origin: `http://127.0.0.1:${preview.port}`,
      },
    ]);
    ws.send('{"id":1,"method":"Browser.getVersion"}');
    await vi.waitFor(() => {
      expect(received).toEqual(['{"id":1,"method":"Browser.getVersion"}']);
    });
    const reply = new Promise<string>((resolve) => {
      ws.once('message', (data) => resolve(String(data)));
    });
    writers[0]?.('{"id":1,"result":{}}');
    expect(await reply).toBe('{"id":1,"result":{}}');
    ws.close();
    await vi.waitFor(() => expect(detached).toBe(1));
  });

  it('detaches the CDP relay when the preview stops', async () => {
    let detached = 0;
    registerPreviewCdpBridge({
      open: () => ({
        connection: { receive: () => undefined },
        detach: () => {
          detached += 1;
        },
      }),
      solePaneId: () => null,
    });
    const preview = await startPreview(dir, scopeA);
    expect((await fetch(new URL('/json/version', preview.url))).status).toBe(404);
    const ws = new WebSocket(
      `ws://127.0.0.1:${preview.port}/cdp/pane-preview?ticket=${encodeURIComponent(preview.cdpTicket)}`,
    );
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
    expect(stopPreview(preview.id, scopeA)).toBe(true);
    await vi.waitFor(() => expect(detached).toBe(1));
    if (ws.readyState === ws.OPEN) ws.close();
  });

  it('does not keep a CDP socket when the pane relay refuses', async () => {
    registerPreviewCdpBridge({
      open: () => null,
      solePaneId: () => null,
    });
    const preview = await startPreview(dir, scopeA);
    const ws = new WebSocket(
      `ws://127.0.0.1:${preview.port}/cdp/missing?ticket=${encodeURIComponent(preview.cdpTicket)}`,
    );
    const code = await new Promise<number>((resolve, reject) => {
      ws.once('close', (next) => resolve(next));
      ws.once('error', reject);
    });
    expect(code).toBe(1008);
  });

  it('does not attach the debugger when a same-origin page upgrades without the CDP capability', async () => {
    let opened = 0;
    registerPreviewCdpBridge({
      open: () => {
        opened += 1;
        return {
          connection: { receive: () => undefined },
          detach: () => undefined,
        };
      },
      solePaneId: () => 'pane-preview',
    });
    const preview = await startPreview(dir, scopeA);
    const discovery = await fetch(new URL('/json/version', preview.url));
    expect(discovery.status).toBe(200);
    const body = (await discovery.json()) as { webSocketDebuggerUrl: string };
    expect(JSON.stringify(body)).not.toContain(preview.cdpTicket);
    expect(discovery.headers.get('set-cookie')).toBeNull();
    const advertised = body.webSocketDebuggerUrl;
    expect(advertised).toBe(`ws://127.0.0.1:${preview.port}/cdp/pane-preview`);

    const pageSocket = new WebSocket(advertised, {
      headers: { Origin: new URL(preview.url).origin },
    });
    await new Promise<void>((resolve) => {
      pageSocket.once('error', () => resolve());
      pageSocket.once('close', () => resolve());
    });
    const headerForgery = new WebSocket(advertised, {
      headers: { 'x-nexus-cdp-ticket': preview.cdpTicket },
    });
    await new Promise<void>((resolve) => {
      headerForgery.once('error', () => resolve());
      headerForgery.once('close', () => resolve());
    });
    expect(opened).toBe(0);

    const privileged = new WebSocket(
      `${advertised}?ticket=${encodeURIComponent(preview.cdpTicket)}`,
    );
    await new Promise<void>((resolve, reject) => {
      privileged.once('open', () => resolve());
      privileged.once('error', reject);
    });
    expect(opened).toBe(1);
    privileged.close();
  });

  it('gives the authorized caller a ticket URL that attaches, and the page that only knows discovery still cannot', async () => {
    let opened = 0;
    registerPreviewCdpBridge({
      open: () => {
        opened += 1;
        return {
          connection: { receive: () => undefined },
          detach: () => undefined,
        };
      },
      solePaneId: () => 'pane-preview',
    });
    const preview = await startPreview(dir, scopeA);
    const authorized = authorizedPreviewCdpUrl(scopeA, preview);
    expect(authorized).toBe(
      `ws://127.0.0.1:${preview.port}/cdp/pane-preview?ticket=${encodeURIComponent(preview.cdpTicket)}`,
    );

    const discovery = await fetch(new URL('/json/version', preview.url));
    const body = (await discovery.json()) as { webSocketDebuggerUrl: string };
    expect(JSON.stringify(body)).not.toContain(preview.cdpTicket);
    expect(JSON.stringify(body)).not.toContain('ticket=');
    expect(body.webSocketDebuggerUrl).toBe(
      `ws://127.0.0.1:${preview.port}/cdp/pane-preview`,
    );

    const pageSocket = new WebSocket(body.webSocketDebuggerUrl, {
      headers: { Origin: new URL(preview.url).origin },
    });
    await new Promise<void>((resolve) => {
      pageSocket.once('error', () => resolve());
      pageSocket.once('close', () => resolve());
    });
    expect(opened).toBe(0);

    const caller = new WebSocket(authorized!);
    await new Promise<void>((resolve, reject) => {
      caller.once('open', () => resolve());
      caller.once('error', reject);
    });
    expect(opened).toBe(1);
    caller.close();
  });

  it('does not give a second mission a CDP url for the first mission pane', async () => {
    const executionScope = testProjectScope({
      projectId: scopeA.projectId,
      checkoutId: scopeA.checkoutId,
      rootRealPath: dir,
    });
    const panes: Record<string, PaneAuthzInfo> = {
      'pane-mission-1': {
        paneId: 'pane-mission-1',
        sessionId: null,
        kind: 'browser',
        missionId: 'mission-1',
        role: 'worker',
        scope: executionScope,
        ownerWebContentsId: 7,
      },
      'pane-mission-2': {
        paneId: 'pane-mission-2',
        sessionId: null,
        kind: 'browser',
        missionId: 'mission-2',
        role: 'worker',
        scope: executionScope,
        ownerWebContentsId: 7,
      },
    };
    const allow = (missionId: string) => (paneId: string) =>
      authorizePaneAccess(
        {
          role: 'worker',
          missionId,
          sessionId: `worker-${missionId}`,
          scope: executionScope,
          ownerWebContentsId: 7,
        },
        panes[paneId]!,
        'write',
      ).allow;
    registerPreviewCdpBridge({
      open: () => null,
      solePaneId: () => null,
      paneIdsOnOrigin: () => ['pane-mission-1', 'pane-mission-2'],
    });
    const preview = await startPreview(dir, scopeA);
    const first = authorizedPreviewCdpUrl(scopeA, preview, allow('mission-1'));
    const second = authorizedPreviewCdpUrl(scopeA, preview, allow('mission-2'));
    expect(first).toContain('/cdp/pane-mission-1?ticket=');
    expect(first).not.toContain('pane-mission-2');
    expect(second).toContain('/cdp/pane-mission-2?ticket=');
    expect(second).not.toContain('pane-mission-1');

    registerPreviewCdpBridge({
      open: () => null,
      solePaneId: () => 'pane-mission-1',
      paneIdsOnOrigin: () => ['pane-mission-1'],
    });
    expect(authorizedPreviewCdpUrl(scopeA, preview, allow('mission-2'))).toBeNull();
  });
});
