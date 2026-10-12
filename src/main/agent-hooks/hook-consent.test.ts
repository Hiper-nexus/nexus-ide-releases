import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readManagedHookConsent,
  resolveManagedHookConsent,
  writeManagedHookConsent,
} from './hook-consent';

const dirs: string[] = [];
function freshUserData(): string {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-hook-consent-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length) {
    try {
      rmSync(dirs.pop()!, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
});

describe('hook-consent', () => {
  it('defaults to undecided when nothing is stored', () => {
    expect(readManagedHookConsent(freshUserData())).toBe('undecided');
  });

  it('prompts exactly once, then persists and reuses the decision', async () => {
    const userDataPath = freshUserData();
    const prompt = vi.fn(async () => 'granted' as const);

    const first = await resolveManagedHookConsent({ userDataPath, prompt });
    expect(first).toBe('granted');
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(readManagedHookConsent(userDataPath)).toBe('granted');

    // Second launch: decision already stored → no prompt.
    const second = await resolveManagedHookConsent({ userDataPath, prompt });
    expect(second).toBe('granted');
    expect(prompt).toHaveBeenCalledTimes(1);
  });

  it('honors a denial and never installs without consent', async () => {
    const userDataPath = freshUserData();
    const prompt = vi.fn(async () => 'denied' as const);
    expect(await resolveManagedHookConsent({ userDataPath, prompt })).toBe('denied');
    expect(readManagedHookConsent(userDataPath)).toBe('denied');
  });

  // F-1255: sem janela para o sheet o prompt devolve 'undecided' — nada é
  // persistido (negação sem pergunta roubaria a escolha) e a próxima chamada
  // pergunta de novo.
  it("prompt 'undecided' persists nothing and asks again later", async () => {
    const userDataPath = freshUserData();
    const prompt = vi
      .fn<() => Promise<'granted' | 'denied' | 'undecided'>>()
      .mockResolvedValueOnce('undecided')
      .mockResolvedValueOnce('granted');

    expect(await resolveManagedHookConsent({ userDataPath, prompt })).toBe('undecided');
    expect(readManagedHookConsent(userDataPath)).toBe('undecided');
    // E nem arquivo é criado: uma negação nunca foi perguntada, então nada
    // pode ser gravado (o arquivo existindo já seria decisão registrada).
    expect(existsSync(join(userDataPath, 'agent-hooks', 'consent.json'))).toBe(false);

    expect(await resolveManagedHookConsent({ userDataPath, prompt })).toBe('granted');
    expect(readManagedHookConsent(userDataPath)).toBe('granted');
    expect(prompt).toHaveBeenCalledTimes(2);
  });

  it('treats a corrupt consent file as undecided (asks again, no silent consent)', async () => {
    const userDataPath = freshUserData();
    writeManagedHookConsent(userDataPath, 'granted');
    // Corrupt it.
    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(userDataPath, 'agent-hooks', 'consent.json'), '{ not json');
    expect(readManagedHookConsent(userDataPath)).toBe('undecided');
  });
});
