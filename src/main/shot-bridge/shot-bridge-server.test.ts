/**
 * Testes do shot-bridge-server: política de caminhos (pura) + fluxo HTTP
 * ponta a ponta (sobe o servidor de verdade em 127.0.0.1, faz o handshake
 * exatamente como o cliente Rust do Nexus Shot e verifica ack + evento).
 */

import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  startShotBridgeServer,
  stopShotBridgeServer,
  shotAllowedRoots,
  validateShotIngestFiles,
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
  // Gravações: ~/Movies no macOS, ~\Videos no Windows (dirs::video_dir do Shot).
  moviesDir = join(home, process.platform === 'win32' ? 'Videos' : 'Movies', 'Nexus Shot');
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
