import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  isRunningPreviewUrl,
  isRunningPreviewUrlForScope,
  listPreviews,
  registerExternalPreview,
  unregisterExternalPreview,
  startPreview,
  stopAllPreviews,
  stopPreview,
  stopPreviewWithProof,
} from './preview-server';

const scopeA = { projectId: 'project-a', checkoutId: 'checkout-a' };
const scopeB = { projectId: 'project-b', checkoutId: 'checkout-b' };

function requestRawPreviewPath(port: number, requestPath: string): Promise<{
  status: number | undefined;
  body: string;
}> {
  return new Promise((resolve, reject) => {
    const request = http.get({ hostname: '127.0.0.1', port, path: requestPath, agent: false }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, body }));
      response.on('error', reject);
    });
    request.setTimeout(1_000, () => request.destroy(new Error('preview request timed out')));
    request.on('error', reject);
  });
}

let dir: string;
let outsideDir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-preview-'));
  outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-preview-outside-'));
  fs.writeFileSync(path.join(dir, 'index.html'), '<h1>preview ok</h1>');
  fs.writeFileSync(path.join(dir, 'app.js'), 'console.log(1)');
});

afterEach(() => {
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

  it.each(['/%', '/%C3%28'])('F-1107: refuses raw malformed path %s without losing the preview', async (requestPath) => {
    const preview = await startPreview(dir, scopeA);
    try {
      await expect(requestRawPreviewPath(preview.port, requestPath)).resolves.toEqual({
        status: 403,
        body: 'forbidden',
      });
      await expect(requestRawPreviewPath(preview.port, '/%69ndex.html?ignored=%')).resolves.toEqual({
        status: 200,
        body: '<h1>preview ok</h1>',
      });
    } finally {
      await stopPreviewWithProof(preview.id, scopeA);
    }
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

  it('F-1076: retains static HTTP while raw CDP discovery/upgrade is absent', async () => {
    const preview = await startPreview(dir, scopeA);
    expect((await fetch(preview.url)).status).toBe(200);
    for (const pathname of ['/json/version','/json/list','/cdp/pane-preview']) {
      const response = await fetch(new URL(pathname,preview.url));
      expect(response.status).toBe(404);
      expect(await response.text()).not.toContain('webSocketDebuggerUrl');
    }
    const ws = new WebSocket(`ws://127.0.0.1:${preview.port}/cdp/pane-preview`);
    const outcome = await new Promise<string>(resolve => {
      ws.once('open',()=>{ws.close();resolve('opened');});
      ws.once('unexpected-response',(_req,res)=>{res.resume();ws.terminate();resolve(`http-${res.statusCode}`);});
      ws.once('error',()=>resolve('refused'));
    });
    expect(outcome).not.toBe('opened');
  });
});

describe('preview-server: mídia e prévias externas (F-1603)', () => {
  function get(port: number, requestPath: string, headers: Record<string, string> = {}) {
    return new Promise<{ status: number | undefined; headers: http.IncomingHttpHeaders; body: Buffer }>((resolve, reject) => {
      const request = http.get({ hostname: '127.0.0.1', port, path: requestPath, headers, agent: false }, (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }));
        response.on('error', reject);
      });
      request.on('error', reject);
    });
  }

  it('serve vídeo e áudio com o tipo certo e faixa de bytes (seek)', async () => {
    fs.writeFileSync(path.join(dir, 'clip.mp4'), Buffer.from('0123456789'));
    fs.writeFileSync(path.join(dir, 'voz.mp3'), Buffer.from('abc'));
    const preview = await startPreview(dir, scopeA);
    const whole = await get(preview.port, '/clip.mp4');
    expect(whole.status).toBe(200);
    expect(whole.headers['content-type']).toBe('video/mp4');
    expect(whole.headers['accept-ranges']).toBe('bytes');
    const part = await get(preview.port, '/clip.mp4', { Range: 'bytes=2-5' });
    expect(part.status).toBe(206);
    expect(part.headers['content-range']).toBe('bytes 2-5/10');
    expect(part.body.toString()).toBe('2345');
    const tail = await get(preview.port, '/clip.mp4', { Range: 'bytes=-3' });
    expect(tail.body.toString()).toBe('789');
    const bad = await get(preview.port, '/clip.mp4', { Range: 'bytes=20-30' });
    expect(bad.status).toBe(416);
    expect(bad.headers['content-range']).toBe('bytes */10');
    expect((await get(preview.port, '/voz.mp3')).headers['content-type']).toBe('audio/mpeg');
  });

  it('prévia externa registrada é confiável só no escopo dela e só enquanto registrada', () => {
    const scope = {
      version: 1 as const,
      installationId: 'installation-a',
      ...scopeA,
      rootRealPath: dir,
      identitySource: 'manifest' as const,
    };
    const url = 'http://127.0.0.1:45991/#project/promo';
    expect(isRunningPreviewUrl(url)).toBe(false);
    registerExternalPreview({ id: 'vpreview-x', port: 45991, root: path.join(dir, 'promo'), ...scopeA });
    try {
      expect(isRunningPreviewUrl(url)).toBe(true);
      expect(isRunningPreviewUrlForScope(url, scope)).toBe(true);
      expect(isRunningPreviewUrlForScope(url, { ...scope, ...scopeB })).toBe(false);
      expect(isRunningPreviewUrlForScope(url, { ...scope, rootRealPath: outsideDir })).toBe(false);
      expect(isRunningPreviewUrl('http://localhost:45991/')).toBe(false);
    } finally {
      unregisterExternalPreview('vpreview-x');
    }
    expect(isRunningPreviewUrl(url)).toBe(false);
    expect(() => registerExternalPreview({ id: 'y', port: 0, root: dir, ...scopeA })).toThrow(/porta/u);
  });
});
