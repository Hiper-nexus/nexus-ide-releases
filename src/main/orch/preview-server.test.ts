import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listPreviews, startPreview, stopAllPreviews, stopPreview } from './preview-server';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-preview-'));
  fs.writeFileSync(path.join(dir, 'index.html'), '<h1>preview ok</h1>');
  fs.writeFileSync(path.join(dir, 'app.js'), 'console.log(1)');
});

afterEach(() => {
  stopAllPreviews();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('preview-server', () => {
  it('serve index.html com content-type e é idempotente por diretório', async () => {
    const first = await startPreview(dir);
    const second = await startPreview(dir);
    expect(second.port).toBe(first.port);

    const res = await fetch(first.url);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(await res.text()).toContain('preview ok');

    const js = await fetch(`${first.url}app.js`);
    expect(js.headers.get('content-type')).toContain('javascript');
  });

  it('bloqueia path traversal para fora da raiz', async () => {
    const { url } = await startPreview(dir);
    const res = await fetch(`${url}..%2f..%2f..%2fetc%2fpasswd`);
    expect([403, 404]).toContain(res.status);
    const res2 = await fetch(`${url}%2e%2e/%2e%2e/etc/passwd`);
    expect([403, 404]).toContain(res2.status);
  });

  it('404 para arquivo inexistente e 405 para métodos de escrita', async () => {
    const { url } = await startPreview(dir);
    expect((await fetch(`${url}nada.css`)).status).toBe(404);
    expect((await fetch(url, { method: 'POST', body: 'x' })).status).toBe(405);
  });

  it('stop encerra e some da listagem', async () => {
    await startPreview(dir);
    expect(listPreviews()).toHaveLength(1);
    expect(stopPreview(dir)).toBe(true);
    expect(listPreviews()).toHaveLength(0);
    expect(stopPreview(dir)).toBe(false);
  });

  it('recusa caminho que não é diretório', async () => {
    await expect(startPreview(path.join(dir, 'index.html'))).rejects.toThrow();
  });
});
