import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  isRunningPreviewUrl,
  isRunningPreviewUrlForScope,
  listPreviews,
  startPreview,
  stopAllPreviews,
  stopPreview,
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

  it('recusa caminho que não é diretório', async () => {
    await expect(
      startPreview(path.join(dir, 'index.html'), scopeA),
    ).rejects.toThrow();
  });
});
