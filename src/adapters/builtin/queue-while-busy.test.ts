import { describe, expect, it } from 'vitest';
import { adapterSchema } from '../../shared/adapter-types';
import { BUILTIN_ADAPTERS } from './index';

describe('F-1393 — quirks.queuesInputWhileBusy', () => {
  const adapters = BUILTIN_ADAPTERS.map((raw) => adapterSchema.parse(raw));
  const flag = (id: string) =>
    adapters.find((adapter) => adapter.id === id)?.quirks.queuesInputWhileBusy === true;

  it('claude declara que enfileira texto + Enter durante o turno', () => {
    expect(flag('claude')).toBe(true);
  });

  it('sem evidência de fila no Nexus, codex e kimi ficam desligados', () => {
    expect(flag('codex')).toBe(false);
    expect(flag('kimi')).toBe(false);
  });

  it('o schema recusa valor não booleano', () => {
    const claude = BUILTIN_ADAPTERS.find((raw) => (raw as { id?: string }).id === 'claude') as Record<string, unknown>;
    const quirks = claude.quirks as Record<string, unknown>;
    expect(adapterSchema.safeParse({ ...claude, quirks: { ...quirks, queuesInputWhileBusy: 'yes' } }).success).toBe(false);
  });
});
