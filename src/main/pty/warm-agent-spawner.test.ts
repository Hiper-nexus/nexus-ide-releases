import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Adapter } from '../../shared/adapter-types';

const deps = vi.hoisted(() => ({
  creator: undefined as undefined | ((cli: string) => Promise<unknown>),
  spawn: vi.fn(() => ({ sessionId: 'warm-session', startKey: 'warm-key' })),
  settle: vi.fn((_adapter: unknown): Promise<void> | null => null),
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

import { registerWarmAgentSpawner } from './warm-agent-spawner';

const adapterFor = (id: string) => ({ id, kind: 'cli-pty', bin: id, quirks: {} }) as unknown as Adapter;
const scope = { rootRealPath: '/synthetic/workspace' } as never;

beforeEach(() => {
  deps.spawn.mockClear();
  deps.settle.mockReset().mockReturnValue(null);
  deps.creator = undefined;
  registerWarmAgentSpawner({
    resolveAdapter: (cli) => adapterFor(cli),
    resolveContext: () => ({ scope, cwd: '/synthetic/workspace' }),
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
