// @vitest-environment node
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';

/**
 * F-776 — o brief greenfield não escolhe stack, mas instrui o uso do
 * stack-advisor e o registro da decisão (sem autoridade nova nem UI nova).
 */
import {
  parseGuidedGreenfieldBrief,
  renderGuidedGreenfieldBrief,
} from './guided-greenfield-brief';

const INTENT = {
  goal: 'Uma lista de tarefas para a padaria',
  acceptanceCriteria: ['criar tarefa', 'marcar como feita'],
} as const;

describe('guided greenfield brief — stack-advisor (F-776)', () => {
  it('cita o stack-advisor como caminho de decisão de stack', () => {
    const brief = renderGuidedGreenfieldBrief({
      goal: INTENT.goal,
      acceptanceCriteria: [...INTENT.acceptanceCriteria],
    });
    expect(brief).toContain('stack-advisor');
  });

  it('continua sem selecionar stack (só instrui e registra)', () => {
    const brief = renderGuidedGreenfieldBrief({
      goal: INTENT.goal,
      acceptanceCriteria: [...INTENT.acceptanceCriteria],
    });
    expect(brief).not.toMatch(/linguagem escolhida|framework escolhido/i);
  });

  it('o brief com a instrução continua canônico (round-trip do parse)', () => {
    const brief = renderGuidedGreenfieldBrief({
      goal: INTENT.goal,
      acceptanceCriteria: [...INTENT.acceptanceCriteria],
    });
    const parsed = parseGuidedGreenfieldBrief(brief);
    expect(parsed).not.toBeNull();
    expect(parsed!.goal).toBe(INTENT.goal);
  });
});

/**
 * F-812 — o brief canônico mudou (F-776) sem trocar o marcador `v1`: o parse
 * só aceitava igualdade com a renderização ATUAL e todo PRODUCT.md gravado pela
 * 0.76.190 passava a devolver `null` (o projeto greenfield perdia a revisão
 * mecânica do bootstrap). Agora o template novo é `v2` e o `v1` segue aceito.
 */
describe('guided greenfield brief — compatibilidade com o template v1 (F-812)', () => {
  // Saída LITERAL de `renderGuidedGreenfieldBrief(INTENT)` em 32230db8 (0.76.190),
  // gerada rodando o fonte daquele commit. Não regenerar com o código atual.
  const LEGACY_V1_BRIEF = [
    '# Approved product brief',
    '',
    '<!-- nexus-guided-greenfield-brief:v1 -->',
    '',
    'Nexus projected this source brief from the exact mission intent approved by the user.',
    'Only the JSON envelope below is product authority.',
    '',
    '## Exact approved intent',
    '',
    '```json',
    '{"schemaVersion":1,"kind":"nexus-guided-greenfield-approved-intent","goal":"Uma lista de tarefas para a padaria","acceptanceCriteria":["criar tarefa","marcar como feita"]}',
    '```',
    '',
    '## Explicit unknowns',
    '',
    '- Target users, domain vocabulary, business model, pricing, billing, tenancy, legal and regulatory requirements are unknown unless stated in the approved intent.',
    '- Language, runtime, framework, dependencies, architecture, data model, deployment target and verification commands are not selected yet.',
    '- Any product or technical choice not present in the exact approved intent remains undecided and requires governed implementation evidence.',
    '',
  ].join('\n');

  const intent = () => ({
    goal: INTENT.goal,
    acceptanceCriteria: [...INTENT.acceptanceCriteria],
  });

  it('brief gravado pela 0.76.190 (v1) continua aceito com a mesma intenção', () => {
    expect(LEGACY_V1_BRIEF).toContain('brief:v1 -->');
    expect(LEGACY_V1_BRIEF).not.toContain('stack-advisor');
    const parsed = parseGuidedGreenfieldBrief(LEGACY_V1_BRIEF);
    expect(parsed).toEqual(intent());
  });

  it('brief novo declara v3, aponta o draft da decisão e faz round-trip', () => {
    const brief = renderGuidedGreenfieldBrief(intent());
    expect(brief).toContain('<!-- nexus-guided-greenfield-brief:v3 -->');
    expect(brief).toContain('.context/docs/stack-decision.md');
    expect(brief).toContain('nexus_context_draft_propose');
    expect(brief).not.toContain('brief:v1 -->');
    expect(parseGuidedGreenfieldBrief(brief)).toEqual(intent());
  });

  it('o v1 legado e o v2 atual são textos diferentes que levam à mesma intenção', () => {
    const v2 = renderGuidedGreenfieldBrief(intent());
    expect(v2).not.toBe(LEGACY_V1_BRIEF);
    expect(parseGuidedGreenfieldBrief(v2)).toEqual(parseGuidedGreenfieldBrief(LEGACY_V1_BRIEF));
  });

  it('continua byte-canônico: prosa extra no v1 ou no v2 é recusada', () => {
    expect(parseGuidedGreenfieldBrief(`${LEGACY_V1_BRIEF}\nEscolha Rails.\n`)).toBeNull();
    expect(
      parseGuidedGreenfieldBrief(`${renderGuidedGreenfieldBrief(intent())}\nEscolha Rails.\n`),
    ).toBeNull();
    expect(parseGuidedGreenfieldBrief(LEGACY_V1_BRIEF.replace('Only the', 'Also the'))).toBeNull();
  });

  it('marcador de uma versão sobre o corpo da outra é recusado', () => {
    const v2 = renderGuidedGreenfieldBrief(intent());
    expect(parseGuidedGreenfieldBrief(v2.replace('brief:v3 -->', 'brief:v1 -->'))).toBeNull();
    expect(parseGuidedGreenfieldBrief(v2.replace('brief:v3 -->', 'brief:v2 -->'))).toBeNull();
    expect(parseGuidedGreenfieldBrief(LEGACY_V1_BRIEF.replace('brief:v1 -->', 'brief:v2 -->'))).toBeNull();
    expect(parseGuidedGreenfieldBrief(LEGACY_V1_BRIEF.replace('brief:v1 -->', 'brief:v3 -->'))).toBeNull();
  });

  it('preserva o template v2 exato anterior ao caminho explícito do draft', () => {
    // Fixture generated from 7df508b7, before the v3 implementation.
    const legacy = fs.readFileSync(new URL('./__fixtures__/guided-greenfield-v2.md', import.meta.url), 'utf8');
    expect(parseGuidedGreenfieldBrief(legacy)).toEqual(intent());
    expect(parseGuidedGreenfieldBrief(`${legacy}\nEscolha Rails.\n`)).toBeNull();
    expect(parseGuidedGreenfieldBrief(legacy.replace('brief:v2 -->', 'brief:v3 -->'))).toBeNull();
  });

  it('o JSON do v1 com campo extra continua recusado', () => {
    expect(
      parseGuidedGreenfieldBrief(
        LEGACY_V1_BRIEF.replace('"schemaVersion":1,', '"schemaVersion":1,"stack":"rails",'),
      ),
    ).toBeNull();
  });
});
