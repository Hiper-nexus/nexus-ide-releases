import { describe, expect, it } from 'vitest';
import {
  civilianSpawnFailMessage,
  isLikelyBootSpawnFailure,
  selectSpawnFailSuccessor,
} from './spawn-fail-reroute';

describe('spawn-fail reroute', () => {
  const roster = [
    {
      id: 'a1',
      agentName: 'Kimi Writer',
      category: 'developer',
      cli: 'kimi',
      model: 'kimi-k2',
    },
    {
      id: 'a2',
      agentName: 'Codex Writer',
      category: 'developer',
      cli: 'codex',
      model: 'gpt-5.3-codex',
    },
    {
      id: 'a3',
      agentName: 'Claude Writer',
      category: 'developer',
      cli: 'claude',
      model: 'claude-opus-4',
    },
    {
      id: 'a4',
      agentName: 'Reviewer',
      category: 'reviewer',
      cli: 'claude',
    },
  ] as const;

  it('escolhe Claude/Codex da mesma categoria após kimi falhar', () => {
    const successor = selectSpawnFailSuccessor({
      deadAdapterId: 'kimi',
      preferredCategory: 'developer',
      roster,
    });
    expect(successor?.cli).toBe('claude');
    expect(successor?.agentName).toBe('Claude Writer');
  });

  it('pula CLIs esgotadas e cai no próximo preferido', () => {
    const successor = selectSpawnFailSuccessor({
      deadAdapterId: 'kimi',
      preferredCategory: 'developer',
      roster,
      exhaustedAdapterIds: ['claude'],
    });
    expect(successor?.cli).toBe('codex');
  });

  it('mensagem civil em PT com sucessor', () => {
    expect(
      civilianSpawnFailMessage({
        deadAdapterId: 'kimi',
        deadLabel: 'Kimi',
        successorCli: 'codex',
        successorName: 'Codex Writer',
      }),
    ).toMatch(/Kimi não iniciou.*Codex Writer \(codex\)/);
  });

  it('detecta falha de boot típica (effort / spawn / ENOENT)', () => {
    expect(isLikelyBootSpawnFailure(new Error('effort ignored'))).toBe(true);
    expect(isLikelyBootSpawnFailure(new Error('pane spawn failed'))).toBe(true);
    expect(isLikelyBootSpawnFailure(new Error('ENOENT binary'))).toBe(true);
    expect(isLikelyBootSpawnFailure(new Error('logic bug elsewhere'))).toBe(
      false,
    );
  });
});
