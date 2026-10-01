import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  probeQwenCredential,
  QWEN_INVALID_CREDENTIAL_MESSAGE,
} from './qwen-readiness';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function tempHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-qwen-probe-'));
  tempDirs.push(dir);
  return dir;
}

function writeSettings(home: string, settings: unknown): void {
  const dir = path.join(home, '.qwen');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(settings));
}

const okFetch = async () => ({ status: 200 });

describe('probeQwenCredential (F-238)', () => {
  it('sem credencial nenhuma → no-credential, sem fetch', async () => {
    const home = tempHome();
    const fetchImpl = vi.fn(okFetch);
    const result = await probeQwenCredential({ home, fetchImpl });
    expect(result.state).toBe('no-credential');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('401 → invalid-credential com a mensagem do Token Plan', async () => {
    const home = tempHome();
    const fetchImpl = vi.fn(async () => ({ status: 401 }));
    const result = await probeQwenCredential({
      home,
      key: 'fixture-key',
      fetchImpl,
    });
    expect(result.state).toBe('invalid-credential');
    expect(result.detail).toBe(QWEN_INVALID_CREDENTIAL_MESSAGE);
  });

  it('usa o baseUrl do settings e manda o Bearer da settings em memória', async () => {
    const home = tempHome();
    writeSettings(home, {
      model: {
        baseUrl: 'https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1',
      },
      env: { BAILIAN_TOKEN_PLAN_API_KEY: 'fixture-settings-key' },
    });
    const fetchImpl = vi.fn(async () => ({ status: 200 }));
    const result = await probeQwenCredential({ home, fetchImpl });
    expect(result.state).toBe('present');
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1/models',
      expect.objectContaining({
        method: 'GET',
        headers: { authorization: 'Bearer fixture-settings-key' },
      }),
    );
  });

  it('falha de rede → unknown (nunca bloqueia)', async () => {
    const home = tempHome();
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    const result = await probeQwenCredential({
      home,
      key: 'fixture-key',
      fetchImpl,
    });
    expect(result.state).toBe('unknown');
  });

  it('200 → present', async () => {
    const home = tempHome();
    const result = await probeQwenCredential({
      home,
      key: 'fixture-key',
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      fetchImpl: okFetch,
    });
    expect(result.state).toBe('present');
  });

  it('baseUrl não-https → unknown sem fetch', async () => {
    const home = tempHome();
    const fetchImpl = vi.fn(okFetch);
    const result = await probeQwenCredential({
      home,
      key: 'fixture-key',
      baseUrl: 'http://example.com/v1',
      fetchImpl,
    });
    expect(result.state).toBe('unknown');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
