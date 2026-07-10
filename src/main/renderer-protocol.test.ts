import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  RENDERER_PROTOCOL_ENTRY_URL,
  RENDERER_PROTOCOL_HOST,
  RENDERER_PROTOCOL_SCHEME,
  createRendererProtocolHandler,
  installRendererProtocol,
  registerRendererProtocolScheme,
} from './renderer-protocol';

describe('renderer protocol registration', () => {
  it('registers only the privileges required by the local renderer', () => {
    const registerSchemesAsPrivileged = vi.fn();

    registerRendererProtocolScheme({ registerSchemesAsPrivileged });

    expect(registerSchemesAsPrivileged).toHaveBeenCalledOnce();
    expect(registerSchemesAsPrivileged).toHaveBeenCalledWith([
      {
        scheme: RENDERER_PROTOCOL_SCHEME,
        privileges: {
          standard: true,
          secure: true,
          supportFetchAPI: true,
          codeCache: true,
        },
      },
    ]);
    const privileges = registerSchemesAsPrivileged.mock.calls[0]?.[0]?.[0]?.privileges;
    expect(privileges).not.toHaveProperty('bypassCSP');
    expect(privileges).not.toHaveProperty('allowServiceWorkers');
    expect(privileges).not.toHaveProperty('corsEnabled');
  });

  it('installs one handler for the exact renderer scheme', () => {
    const handle = vi.fn();

    installRendererProtocol({ handle }, '/app/.vite/renderer/main_window');

    expect(handle).toHaveBeenCalledOnce();
    expect(handle).toHaveBeenCalledWith(
      RENDERER_PROTOCOL_SCHEME,
      expect.any(Function),
    );
    expect(RENDERER_PROTOCOL_HOST).toBe('bundle');
    expect(RENDERER_PROTOCOL_ENTRY_URL).toBe(
      `${RENDERER_PROTOCOL_SCHEME}://${RENDERER_PROTOCOL_HOST}/index.html`,
    );
  });
});

describe('renderer protocol handler', () => {
  let tempDir: string;
  let rendererRoot: string;
  let outsideFile: string;
  let handler: ReturnType<typeof createRendererProtocolHandler>;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'nexus-renderer-protocol-'));
    rendererRoot = path.join(tempDir, 'renderer');
    outsideFile = path.join(tempDir, 'outside-secret.txt');
    await mkdir(path.join(rendererRoot, 'assets'), { recursive: true });
    await writeFile(
      path.join(rendererRoot, 'index.html'),
      '<!doctype html><main id="root"></main>',
    );
    await writeFile(path.join(rendererRoot, 'assets', 'index-ABC12345.js'), 'export {};');
    await writeFile(path.join(rendererRoot, 'assets', 'font.ttf'), Buffer.from([0, 1, 2]));
    await writeFile(outsideFile, 'do not expose');
    handler = createRendererProtocolHandler(rendererRoot);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('serves only a regular file below the renderer root with safe headers', async () => {
    const response = await handler(new Request(RENDERER_PROTOCOL_ENTRY_URL));

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.text()).toContain('id="root"');
  });

  it('serves Vite assets with the right MIME type and immutable cache policy', async () => {
    const response = await handler(
      new Request(`${RENDERER_PROTOCOL_SCHEME}://${RENDERER_PROTOCOL_HOST}/assets/index-ABC12345.js`),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect(response.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(await response.text()).toBe('export {};');
  });

  it('supports HEAD without returning file contents', async () => {
    const response = await handler(
      new Request(
        `${RENDERER_PROTOCOL_SCHEME}://${RENDERER_PROTOCOL_HOST}/assets/font.ttf`,
        { method: 'HEAD' },
      ),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('font/ttf');
    expect(response.headers.get('content-length')).toBe('3');
    expect(await response.text()).toBe('');
  });

  it('rejects methods that could mutate protocol state', async () => {
    const response = await handler(
      new Request(RENDERER_PROTOCOL_ENTRY_URL, { method: 'POST', body: 'x' }),
    );

    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('GET, HEAD');
  });

  it.each([
    `${RENDERER_PROTOCOL_SCHEME}://other/index.html`,
    `${RENDERER_PROTOCOL_SCHEME}://${RENDERER_PROTOCOL_HOST}:443/index.html`,
    `https://${RENDERER_PROTOCOL_HOST}/index.html`,
  ])('rejects URLs outside the exact local origin: %s', async (url) => {
    const response = await handler(new Request(url));

    expect(response.status).toBe(403);
  });

  it('rejects URL credentials even if a caller bypasses Request construction', async () => {
    const response = await handler({
      method: 'GET',
      url: `${RENDERER_PROTOCOL_SCHEME}://user:pass@${RENDERER_PROTOCOL_HOST}/index.html`,
    } as Request);

    expect(response.status).toBe(403);
  });

  it.each([
    '%2e%2e%2foutside-secret.txt',
    '%2e%2e%5coutside-secret.txt',
    'assets%2f..%2f..%2foutside-secret.txt',
  ])('blocks encoded traversal: %s', async (pathname) => {
    const response = await handler(
      new Request(
        `${RENDERER_PROTOCOL_SCHEME}://${RENDERER_PROTOCOL_HOST}/${pathname}`,
      ),
    );

    expect(response.status).toBe(403);
    expect(await response.text()).not.toContain('do not expose');
  });

  it('blocks symlinks that resolve outside the renderer root', async () => {
    await symlink(outsideFile, path.join(rendererRoot, 'assets', 'escaped.txt'));

    const response = await handler(
      new Request(
        `${RENDERER_PROTOCOL_SCHEME}://${RENDERER_PROTOCOL_HOST}/assets/escaped.txt`,
      ),
    );

    expect(response.status).toBe(403);
    expect(await response.text()).not.toContain('do not expose');
  });

  it('does not expose directories, missing files, or local filesystem paths', async () => {
    const directory = await handler(
      new Request(`${RENDERER_PROTOCOL_SCHEME}://${RENDERER_PROTOCOL_HOST}/assets/`),
    );
    const missing = await handler(
      new Request(`${RENDERER_PROTOCOL_SCHEME}://${RENDERER_PROTOCOL_HOST}/missing.js`),
    );

    expect(directory.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(await missing.text()).not.toContain(tempDir);
  });

  it('rejects malformed URL encoding without throwing', async () => {
    const response = await handler(
      new Request(
        `${RENDERER_PROTOCOL_SCHEME}://${RENDERER_PROTOCOL_HOST}/%E0%A4%A`,
      ),
    );

    expect(response.status).toBe(400);
  });
});
