import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./account-store', () => ({
  agyAccountCredentialBlob: vi.fn(),
  preserveAgyKeyringSession: vi.fn(),
}));

import {
  AGY_KEYRING_SETTLE_MS,
  activateAgyAccountForSpawn,
  resetAgyKeyringActivationForTests,
  type AgyKeyringActivationDeps,
} from './agy-keyring-activation';

const jwt = (claims: Record<string, unknown>) =>
  `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;
const session = (sub: string, refresh = `r-${sub}`) =>
  JSON.stringify({
    token: { access_token: `a-${sub}`, token_type: 'Bearer', refresh_token: refresh, expiry: '2026-09-28T20:00:00Z' },
    auth_method: 'consumer',
    id_token: jwt({ sub, email: `${sub}@example.com` }),
  });

function harness(initialSlot: string | null, vault: Record<string, string>) {
  let slot = initialSlot;
  let clock = 1_000;
  const deps: AgyKeyringActivationDeps & {
    writes: string[];
    preserved: string[];
    slept: number[];
  } = {
    platform: 'win32',
    now: () => clock,
    sleep: async (ms) => {
      deps.slept.push(ms);
      clock += ms;
    },
    readSlot: () => slot,
    writeSlot: (blob) => {
      deps.writes.push(blob);
      slot = blob;
      return true;
    },
    accountBlob: (id) => vault[id] ?? null,
    preserve: (blob) => {
      deps.preserved.push(blob);
    },
    writes: [],
    preserved: [],
    slept: [],
  };
  return { deps, slot: () => slot, advance: (ms: number) => { clock += ms; } };
}

beforeEach(() => resetAgyKeyringActivationForTests());

describe('conta AGY por pane no Windows (F-677)', () => {
  it('troca a vaga para a conta escolhida e guarda a sessão que estava nela', async () => {
    const h = harness(session('A'), { b: session('B') });
    await expect(activateAgyAccountForSpawn('b', h.deps)).resolves.toEqual({ ok: true, switched: true });
    expect(h.deps.preserved).toEqual([session('A')]);
    expect(h.slot()).toBe(session('B'));
  });

  it('vaga já na conta: não grava, só guarda o token mais novo dela', async () => {
    const fresher = session('B', 'r-B-rotated');
    const h = harness(fresher, { b: session('B') });
    await expect(activateAgyAccountForSpawn('b', h.deps)).resolves.toEqual({ ok: true, switched: false });
    expect(h.deps.writes).toEqual([]);
    expect(h.deps.preserved).toEqual([fresher]);
  });

  it('segunda conta diferente espera o AGY anterior ler a vaga', async () => {
    const h = harness(session('A'), { b: session('B'), c: session('C') });
    await activateAgyAccountForSpawn('b', h.deps);
    h.advance(1_000);
    await activateAgyAccountForSpawn('c', h.deps);
    expect(h.deps.slept).toEqual([AGY_KEYRING_SETTLE_MS - 1_000]);
    expect(h.slot()).toBe(session('C'));
    // Mesma conta em seguida passa direto, sem folga.
    await activateAgyAccountForSpawn('c', h.deps);
    expect(h.deps.slept).toHaveLength(1);
  });

  it('falha de gravação restaura a vaga anterior e diz o motivo', async () => {
    const h = harness(session('A'), { b: session('B') });
    const original = session('A');
    let first = true;
    h.deps.writeSlot = vi.fn((blob: string) => {
      if (first) {
        first = false;
        return false;
      }
      return blob === original;
    });
    const result = await activateAgyAccountForSpawn('b', h.deps);
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('Gerenciador de Credenciais') });
    expect(h.deps.writeSlot).toHaveBeenLastCalledWith(original);
  });

  it('não troca nada se não conseguir guardar a sessão atual', async () => {
    const h = harness(session('A'), { b: session('B') });
    h.deps.preserve = () => {
      throw new Error('vault indisponível');
    };
    await expect(activateAgyAccountForSpawn('b', h.deps)).resolves.toMatchObject({ ok: false });
    expect(h.deps.writes).toEqual([]);
    expect(h.slot()).toBe(session('A'));
  });

  it('conta salva no formato do Gemini CLI (sem id_token) pede novo login em vez de gravar lixo', async () => {
    const h = harness(session('A'), { b: JSON.stringify({ access_token: 'x', refresh_token: 'y' }) });
    await expect(activateAgyAccountForSpawn('b', h.deps)).resolves.toMatchObject({ ok: false });
    expect(h.deps.writes).toEqual([]);
  });

  it('fora do Windows é no-op', async () => {
    const h = harness(session('A'), { b: session('B') });
    h.deps.platform = 'darwin';
    await expect(activateAgyAccountForSpawn('b', h.deps)).resolves.toEqual({ ok: true, switched: false });
    expect(h.deps.writes).toEqual([]);
  });
});
