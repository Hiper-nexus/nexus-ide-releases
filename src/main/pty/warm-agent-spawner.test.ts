import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Adapter } from '../../shared/adapter-types';

const deps = vi.hoisted(() => ({
  creator: undefined as undefined | ((cli: string) => Promise<unknown>),
  spawn: vi.fn(() => ({ sessionId: 'warm-session', startKey: 'warm-key' })),
  settle: vi.fn((_adapter: unknown): Promise<void> | null => null),
  permit: vi.fn(async (_cli: string) => deps.release),
  release: vi.fn(),
}));

vi.mock('./pty-manager', () => ({
  setWarmAgentSpawner: (creator: (cli: string) => Promise<unknown>) => { deps.creator = creator; },
  spawnAgentSession: deps.spawn,
}));
vi.mock('./warm-pool', () => ({ warmPool: { drain: vi.fn() } }));
vi.mock('../license-access', () => ({
  onAccessChanged: () => () => undefined,
  requireAccess: () => ({ ok: true }),
}));
vi.mock('../orch/codex-cli-version', () => ({ settleCodexCliVersionForSpawn: deps.settle }));
const heavyBase = vi.hoisted(() => ({ missing: false }));
vi.mock('../orch/native-heavy-preload', () => ({
  ensureNativeHeavyJobBase: () => undefined,
  nativeHeavyJobBaseMissing: () => heavyBase.missing,
}));

import { registerWarmAgentSpawner } from './warm-agent-spawner';

const adapterFor = (id: string) => ({ id, kind: 'cli-pty', bin: id, quirks: {} }) as unknown as Adapter;
const scope = { rootRealPath: '/synthetic/workspace' } as never;

beforeEach(() => {
  heavyBase.missing = false;
  deps.spawn.mockClear();
  deps.settle.mockReset().mockReturnValue(null);
  deps.creator = undefined;
  deps.release.mockReset();
  deps.permit.mockReset().mockImplementation(async () => deps.release);
  registerWarmAgentSpawner({
    resolveAdapter: (cli) => adapterFor(cli),
    resolveContext: () => ({ scope, cwd: '/synthetic/workspace' }),
    acquireSpawnPermit: deps.permit,
  });
});

describe('F-790: pane ocioso do warm pool e a versão do Codex', () => {
  it('Codex com a sonda em voo: o pane ocioso só nasce depois dela', async () => {
    let finish!: () => void;
    deps.settle.mockReturnValueOnce(new Promise<void>((resolve) => { finish = resolve; }));
    const pending = deps.creator!('codex');
    await Promise.resolve();
    await Promise.resolve();
    expect(deps.settle).toHaveBeenCalledWith(expect.objectContaining({ id: 'codex' }));
    expect(deps.spawn).not.toHaveBeenCalled();
    finish();
    await expect(pending).resolves.toMatchObject({ sessionId: 'warm-session', cli: 'codex' });
    expect(deps.spawn).toHaveBeenCalledOnce();
  });

  it('sem nada a esperar (null) — outras CLIs — o pane nasce direto', async () => {
    await expect(deps.creator!('claude')).resolves.toMatchObject({ sessionId: 'warm-session', cli: 'claude' });
    expect(deps.settle).toHaveBeenCalledWith(expect.objectContaining({ id: 'claude' }));
    expect(deps.spawn).toHaveBeenCalledOnce();
  });
});

describe('F-955: pane ocioso sem a base do job nativo', () => {
  it('não nasce enquanto a base falta: seria adotado depois sem comandos pesados', async () => {
    heavyBase.missing = true;
    await expect(deps.creator!('claude')).resolves.toBeNull();
    expect(deps.spawn).not.toHaveBeenCalled();
  });
});

// R2: o pane ocioso pega o MESMO permit dos panes normais — com um
// `npm install -g` em curso ele espera, e o updater enxerga o spawn em voo.
describe('R2: pane ocioso do warm pool e o permit de atualização da CLI', () => {
  it('não nasce enquanto o permit da CLI está preso; solta o permit depois do spawn', async () => {
    let grant!: (release: () => void) => void;
    deps.permit.mockImplementationOnce(() => new Promise((resolve) => { grant = resolve; }));
    const pending = deps.creator!('opencode');
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(deps.permit).toHaveBeenCalledWith('opencode');
    expect(deps.spawn).not.toHaveBeenCalled();
    grant(deps.release);
    await expect(pending).resolves.toMatchObject({ sessionId: 'warm-session', cli: 'opencode' });
    expect(deps.spawn).toHaveBeenCalledOnce();
    expect(deps.release).toHaveBeenCalledOnce();
  });

  it('spawn que lança ainda solta o permit', async () => {
    deps.spawn.mockImplementationOnce(() => { throw new Error('pty falhou'); });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await expect(deps.creator!('claude')).resolves.toBeNull();
    expect(deps.release).toHaveBeenCalledOnce();
    warn.mockRestore();
  });
});
