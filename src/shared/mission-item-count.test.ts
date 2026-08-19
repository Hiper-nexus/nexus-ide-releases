import { describe, expect, it } from 'vitest';
import {
  countEnumeratedMissionItems,
  countMissionItems,
  extractListedMissionItems,
  listedItemsLookLikeRoleCollapse,
  MAX_SEALED_MISSION_ITEMS,
  requestedMissionItemCount,
  targetParallelWriters,
} from './mission-item-count';

function twentyStoryList(): string {
  return Array.from(
    { length: 20 },
    (_, index) => `${index + 1}. Story ${index + 1} da waitlist`,
  ).join('\n');
}

describe('extractListedMissionItems', () => {
  it('lista numerada de 20 stories vira 20 itens (não papéis do squad)', () => {
    const items = extractListedMissionItems(
      `Monte um SaaS de waitlist com estas stories:\n${twentyStoryList()}`,
    );
    expect(items).toHaveLength(20);
    expect(items[0]).toBe('Story 1 da waitlist');
    expect(items[19]).toBe('Story 20 da waitlist');
    expect(countMissionItems(`preamble\n${twentyStoryList()}`)).toBe(20);
  });

  it('one-liner civil fica um plano pequeno', () => {
    const items = extractListedMissionItems('Crie um botão de login.');
    expect(items).toEqual(['Crie um botão de login.']);
    expect(countMissionItems('Crie um botão de login.')).toBe(1);
  });

  it('parágrafo quebrado em 2 linhas não explode em duas tasks', () => {
    expect(
      extractListedMissionItems(
        'Crie um botão de login\nna tela inicial do app.',
      ),
    ).toHaveLength(1);
  });

  it('aceita bullets e headings BMAD Story N.M', () => {
    expect(
      extractListedMissionItems('- Landing page\n- Auth magic link\n- Waitlist'),
    ).toEqual(['Landing page', 'Auth magic link', 'Waitlist']);
    expect(
      extractListedMissionItems(
        '### Story 1.1: Landing\ncorpo\n### Story 1.2: Auth\ncorpo',
      ),
    ).toEqual(['Landing', 'Auth']);
  });

  it('objetivo vazio não inventa item', () => {
    expect(extractListedMissionItems('   ')).toEqual([]);
    expect(countMissionItems('')).toBe(0);
  });

  it('prosa "exatamente 20 user stories" vira 20 placeholders (não 1 papel)', () => {
    const items = extractListedMissionItems(
      'Monte um SaaS de waitlist com exatamente 20 user stories.',
    );
    expect(items).toHaveLength(20);
    expect(items[0]).toBe('Story 01');
    expect(items[19]).toBe('Story 20');
    expect(countMissionItems('Quero 20 histórias de usuário neste SaaS')).toBe(
      20,
    );
    expect(requestedMissionItemCount('São 20 entregas, sem colapso.')).toBe(20);
  });

  it('item-01 / stories/01.md listados viram N tasks', () => {
    const item01 = Array.from(
      { length: 20 },
      (_, index) =>
        `item-${String(index + 1).padStart(2, '0')}: Entrega ${index + 1}`,
    ).join('\n');
    expect(extractListedMissionItems(item01)).toHaveLength(20);
    expect(extractListedMissionItems(item01)[0]).toBe('Entrega 1');

    const files = Array.from(
      { length: 20 },
      (_, index) =>
        `stories/${String(index + 1).padStart(2, '0')}.md — Slice ${index + 1}`,
    ).join('\n');
    expect(extractListedMissionItems(files)).toHaveLength(20);
    expect(extractListedMissionItems(files)[19]).toBe('Slice 20');
  });

  it('lista de papéis do squad + pedido de 20 stories sela 20, não 5', () => {
    const collapsed = [
      'Monte um SaaS com exatamente 20 user stories.',
      '1. Frontend',
      '2. Backend',
      '3. Generalist',
      '4. UX Designer',
      '5. Maestro',
    ].join('\n');
    const items = extractListedMissionItems(collapsed);
    expect(listedItemsLookLikeRoleCollapse(['Frontend', 'Backend', 'UX'])).toBe(
      true,
    );
    expect(items).toHaveLength(20);
    expect(items[0]).toBe('Story 01');
    expect(items).not.toContain('Frontend');
  });

  it('não inventa 20 a partir de um número solto', () => {
    expect(extractListedMissionItems('Crie um botão que custa 20 reais.')).toEqual(
      ['Crie um botão que custa 20 reais.'],
    );
    expect(requestedMissionItemCount('Crie um botão de login.')).toBeNull();
  });

  it('respeita o teto de 64 (mesmo de nexus_task plan)', () => {
    const lines = Array.from(
      { length: MAX_SEALED_MISSION_ITEMS + 8 },
      (_, index) => `${index + 1}. Extra ${index + 1}`,
    ).join('\n');
    expect(extractListedMissionItems(lines)).toHaveLength(
      MAX_SEALED_MISSION_ITEMS,
    );
  });
});

describe('aliases do fast-lane', () => {
  it('countEnumeratedMissionItems espelha countMissionItems', () => {
    const objective = twentyStoryList();
    expect(countEnumeratedMissionItems(objective)).toBe(
      countMissionItems(objective),
    );
  });

  it('targetParallelWriters sobe até 7 em plano grande', () => {
    expect(targetParallelWriters(1)).toBe(1);
    expect(targetParallelWriters(20)).toBe(7);
  });
});
