import { describe, expect, it } from 'vitest';
import {
  buildEnrichMessages,
  chunkItems,
  enrichedBlockForArchitect,
  mergeEnriched,
  parseEnrichResponse,
  runHarnessEnrich,
  type EnrichableItem,
  type EnrichedCatalog,
} from './harness-enrich';

function item(name: string, kind: 'agent' | 'skill' = 'agent'): EnrichableItem {
  return { name, kind };
}

describe('chunkItems', () => {
  it('divide em chunks do tamanho pedido', () => {
    const items = Array.from({ length: 95 }, (_, i) => item(`a${i}`));
    const chunks = chunkItems(items, 40);
    expect(chunks.map((c) => c.length)).toEqual([40, 40, 15]);
  });
});

describe('parseEnrichResponse', () => {
  const expected = [item('scout-web'), item('impeccable', 'skill')];

  it('aceita itens válidos e ignora nomes fora do chunk', () => {
    const raw = JSON.stringify({
      items: [
        { name: 'scout-web', kind: 'agent', tier: 'scout', blurb: 'pesquisa na web' },
        { name: 'impeccable', kind: 'skill', tier: 'builder', blurb: 'design de UI', whenToUse: 'quando houver frontend' },
        { name: 'inventado', kind: 'agent', tier: 'reviewer', blurb: 'não existe' },
      ],
    });
    const parsed = parseEnrichResponse(raw, expected);
    expect(parsed.map((p) => p.name)).toEqual(['scout-web', 'impeccable']);
    expect(parsed[1].whenToUse).toBe('quando houver frontend');
  });

  it('tier inválido cai para builder e blurb é clampado', () => {
    const raw = JSON.stringify({
      items: [
        { name: 'scout-web', kind: 'agent', tier: 'ninja', blurb: 'x'.repeat(500) },
      ],
    });
    const parsed = parseEnrichResponse(raw, expected);
    expect(parsed[0].tier).toBe('builder');
    expect(parsed[0].blurb.length).toBeLessThanOrEqual(160);
  });

  it('JSON inválido degrada para lista vazia', () => {
    expect(parseEnrichResponse('not json', expected)).toEqual([]);
  });
});

describe('mergeEnriched', () => {
  it('acumula por (kind,name) com o fresco vencendo', () => {
    const prev: EnrichedCatalog = {
      version: 1,
      updatedAt: 1,
      items: [
        { name: 'a', kind: 'agent', tier: 'scout', blurb: 'antigo' },
        { name: 'b', kind: 'skill', tier: 'builder', blurb: 'fica' },
      ],
    };
    const merged = mergeEnriched(
      prev,
      [{ name: 'a', kind: 'agent', tier: 'reviewer', blurb: 'novo' }],
      99,
    );
    expect(merged.updatedAt).toBe(99);
    expect(merged.items).toHaveLength(2);
    expect(merged.items.find((i) => i.name === 'a')?.blurb).toBe('novo');
    expect(merged.items.find((i) => i.name === 'b')?.blurb).toBe('fica');
  });
});

describe('runHarnessEnrich', () => {
  it('retries a failed chunk in smaller batches and merges exact items', async () => {
    const items = Array.from({ length: 3 }, (_, i) => item(`agent-${i}`));
    let failedOnce = false;
    const chat = async (messages: Array<{ role: string; content: string }>): Promise<string> => {
      const user = messages.find((message) => message.role === 'user')?.content ?? '';
      const name = /- (agent-\d+) \(agent\)/.exec(user)?.[1] ?? '';
      if (name === 'agent-1' && !failedOnce) {
        failedOnce = true;
        throw new Error('provider caiu');
      }
      return JSON.stringify({
        items: [
          { name, kind: 'agent', tier: 'scout', blurb: `ok ${name}` },
        ],
      });
    };
    const result = await runHarnessEnrich(items, chat, {
      chunkSize: 1,
      prev: null,
      now: () => 42,
    });
    expect(result.items.map((i) => i.name).sort()).toEqual([
      'agent-0',
      'agent-1',
      'agent-2',
    ]);
    expect(result.updatedAt).toBe(42);
  });

  it('retries only names omitted by a partial model response', async () => {
    const items = [item('a'), item('b'), item('c')];
    const calls: string[] = [];
    const result = await runHarnessEnrich(
      items,
      async (messages) => {
        const user = messages.find((message) => message.role === 'user')?.content ?? '';
        calls.push(user);
        const names = [...user.matchAll(/- ([a-z]) \(agent\)/g)].map((match) => match[1]);
        const selected = calls.length === 1 ? names.slice(0, 1) : names;
        return JSON.stringify({
          items: selected.map((name) => ({
            name,
            kind: 'agent',
            tier: 'builder',
            blurb: `descrição ${name}`,
          })),
        });
      },
      { chunkSize: 3, now: () => 7 },
    );

    expect(calls).toHaveLength(2);
    expect(result.items.map((entry) => entry.name).sort()).toEqual(['a', 'b', 'c']);
  });

  it('keeps complete inventory coverage when every provider call fails', async () => {
    const items = [
      item('deep-research'),
      item('security-reviewer'),
      item('react-builder', 'skill'),
    ];

    const result = await runHarnessEnrich(items, async () => {
      throw new Error('all providers unavailable');
    });

    expect(result.items.map((entry) => entry.name).sort()).toEqual(
      items.map((entry) => entry.name).sort(),
    );
    expect(result.items.every((entry) => entry.blurb.length > 0)).toBe(true);
    expect(result.items.find((entry) => entry.name === 'deep-research')?.tier).toBe(
      'scout',
    );
    expect(
      result.items.find((entry) => entry.name === 'security-reviewer')?.tier,
    ).toBe('reviewer');
  });

  it('drops stale cached entries that are no longer installed', async () => {
    const prev: EnrichedCatalog = {
      version: 1,
      updatedAt: 1,
      items: [
        { name: 'still-here', kind: 'agent', tier: 'builder', blurb: 'old' },
        { name: 'removed', kind: 'skill', tier: 'scout', blurb: 'stale' },
      ],
    };

    const result = await runHarnessEnrich(
      [item('still-here')],
      async () =>
        JSON.stringify({
          items: [
            {
              name: 'still-here',
              kind: 'agent',
              tier: 'builder',
              blurb: 'fresh',
            },
          ],
        }),
      { prev },
    );

    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({ name: 'still-here', blurb: 'fresh' });
  });
});

describe('enrichedBlockForArchitect', () => {
  it('agrupa por tier e respeita o teto de caracteres', () => {
    const cat: EnrichedCatalog = {
      version: 1,
      updatedAt: 1,
      items: [
        { name: 'pesquisador', kind: 'agent', tier: 'scout', blurb: 'busca refs' },
        { name: 'ui-builder', kind: 'agent', tier: 'builder', blurb: 'constrói UI' },
        { name: 'qa-hawk', kind: 'agent', tier: 'reviewer', blurb: 'quebra tudo' },
      ],
    };
    const block = enrichedBlockForArchitect(cat, 2_000);
    expect(block).toContain('SCOUT');
    expect(block).toContain('pesquisador');
    expect(block).toContain('REVIEWER');
    expect(enrichedBlockForArchitect(cat, 30).length).toBeLessThanOrEqual(30);
  });

  it('catálogo vazio vira string vazia', () => {
    expect(enrichedBlockForArchitect(null, 1000)).toBe('');
  });
});

describe('buildEnrichMessages', () => {
  it('inclui nome e kind de cada item do chunk', () => {
    const msgs = buildEnrichMessages([item('a'), item('b', 'skill')]);
    const user = msgs.find((m) => m.role === 'user')?.content ?? '';
    expect(user).toContain('a (agent)');
    expect(user).toContain('b (skill)');
  });
});
