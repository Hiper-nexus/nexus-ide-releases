/** @vitest-environment jsdom */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MissionReview } from '../../../shared/mission-engine-contract';
import type { MissionLane } from '../../../shared/mission-intent';
import { ReviewStep } from './ReviewStep';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const CUSTOM_REVIEW: MissionReview = {
  missionId: 'mission-sealed-role-authority',
  title: 'Revisar a autoridade exata da equipe',
  objective:
    'Confirmar instruções, ferramentas e habilidades de cada papel antes da missão.',
  workspaceLabel: 'nexus (/projects/nexus)',
  contextPaths: [],
  roster: [
    {
      id: 'custom-coordinator',
      agentName: 'Coordenadora de entrega',
      category: 'orchestrator',
      cli: 'claude',
      model: 'sonnet',
      instructions:
        'Conduza a entrega em duas ondas. Pare antes de qualquer mudança fora do objetivo aprovado.',
      allowedTools: null,
      allowedSkills: [],
    },
    {
      id: 'custom-interface-builder',
      agentName: 'Especialista de interface',
      category: 'executor',
      cli: 'codex',
      model: 'gpt-5.6-sol',
      effort: 'high',
      instructions:
        'Implemente somente a interface revisada e preserve integralmente a navegação por teclado.',
      allowedTools: ['Read', 'Edit'],
      allowedSkills: ['react-patterns', 'a11y-debugging'],
    },
    {
      id: 'custom-reviewer',
      agentName: 'Revisora independente',
      category: 'reviewer',
      cli: 'codex',
      model: 'gpt-5.6-sol',
      effort: 'medium',
      instructions:
        'Verifique a entrega completa e relate qualquer diferença antes de aprovar o resultado.',
      allowedTools: [],
      allowedSkills: null,
    },
  ],
  permissions: [],
  warnings: [],
  reviewSha256: 'b'.repeat(64),
  createdAt: 1_786_089_600_000,
};

const REVIEW_LANE_CASES = [
  {
    lane: 'standard',
    label: 'Construir ou alterar o produto',
    authority: [/editar arquivos/i, /dentro da pasta/i],
  },
  {
    lane: 'consult',
    label: 'Investigar sem alterar arquivos',
    authority: [
      /somente leitura/i,
      /(?:sem alterar|não (?:pode )?alterar) arquivos/i,
    ],
  },
  {
    lane: 'plan',
    label: 'Preparar um plano',
    authority: [
      /somente leitura/i,
      /preparar um plano/i,
      /(?:sem alterar|não (?:pode )?alterar) arquivos/i,
    ],
  },
  {
    lane: 'ops',
    label: 'Operar infraestrutura',
    authority: [
      /ações de infraestrutura/i,
      /não (?:pode )?alterar (?:o repositório|arquivos do projeto)/i,
    ],
  },
] as const;

const mountedRoots = new Set<Root>();

function render(node: ReactNode): HTMLElement {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  mountedRoots.add(root);
  act(() => root.render(node));
  return host;
}

function renderReadyReview(
  review: MissionReview = CUSTOM_REVIEW,
  lane: MissionLane = 'standard',
): HTMLElement {
  return render(
    <ReviewStep
      review={review}
      lane={lane}
      prepareStatus="ready"
      startStatus="idle"
      error={null}
      onBack={vi.fn()}
      onRetryPrepare={vi.fn()}
      onStart={vi.fn()}
    />,
  );
}

function normalizedText(node: Element): string {
  return (node.textContent ?? '').replace(/\s+/g, ' ').trim();
}

function detailedRole(host: HTMLElement, name: string): HTMLLIElement {
  const found = Array.from(host.querySelectorAll('li')).find((item) => {
    const roleName = item.querySelector('strong')?.textContent?.trim();
    return roleName === name && normalizedText(item).includes('Instruções');
  });
  if (!found) throw new Error(`Detailed role not found: ${name}`);
  return found;
}

function startButton(host: HTMLElement): HTMLButtonElement {
  const found = Array.from(host.querySelectorAll('button')).find(
    (item) => item.textContent?.trim() === 'Iniciar missão',
  );
  if (!found) throw new Error('Start button not found');
  return found;
}

afterEach(() => {
  for (const root of mountedRoots) {
    act(() => root.unmount());
  }
  mountedRoots.clear();
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe('ReviewStep', () => {
  it('shows every custom role instruction and its exact sealed authority before starting', () => {
    const host = render(
      <ReviewStep
        review={CUSTOM_REVIEW}
        lane="standard"
        prepareStatus="ready"
        startStatus="idle"
        error={null}
        onBack={vi.fn()}
        onRetryPrepare={vi.fn()}
        onStart={vi.fn()}
      />,
    );

    const coordinator = detailedRole(host, 'Coordenadora de entrega');
    const coordinatorText = normalizedText(coordinator);
    expect(coordinatorText).toContain(
      'Instruções: Conduza a entrega em duas ondas. Pare antes de qualquer mudança fora do objetivo aprovado.',
    );
    expect(coordinatorText).toMatch(
      /Ferramentas permitidas:? Sem lista restrita; este papel pode usar qualquer ferramenta disponível\./i,
    );
    expect(coordinatorText).toMatch(
      /Habilidades permitidas:? Nenhuma habilidade autorizada para este papel\./i,
    );

    const builder = detailedRole(host, 'Especialista de interface');
    const builderText = normalizedText(builder);
    expect(builderText).toContain(
      'Instruções: Implemente somente a interface revisada e preserve integralmente a navegação por teclado.',
    );
    expect(builderText).toMatch(
      /Ferramentas permitidas:?.*Ler arquivos.*Editar arquivos/i,
    );
    expect(builderText).not.toContain('Executar comandos');
    expect(builderText).toMatch(
      /Habilidades permitidas:? react-patterns, a11y-debugging(?:\.|$)/i,
    );

    const reviewer = detailedRole(host, 'Revisora independente');
    const reviewerText = normalizedText(reviewer);
    expect(reviewerText).toContain(
      'Instruções: Verifique a entrega completa e relate qualquer diferença antes de aprovar o resultado.',
    );
    expect(reviewerText).toMatch(
      /Ferramentas permitidas:? Nenhuma ferramenta autorizada para este papel\./i,
    );
    expect(reviewerText).toMatch(
      /Habilidades permitidas:? Sem lista restrita; este papel pode usar qualquer habilidade disponível\./i,
    );

    const start = startButton(host);
    for (const role of [coordinator, builder, reviewer]) {
      expect(role.closest('details')?.open ?? true).toBe(true);
      expect(
        Boolean(role.compareDocumentPosition(start) & Node.DOCUMENT_POSITION_FOLLOWING),
      ).toBe(true);
    }
  });

  it('states null grants as honestly unrestricted without claiming a hidden work-type limit', () => {
    const host = renderReadyReview();
    const coordinatorText = normalizedText(
      detailedRole(host, 'Coordenadora de entrega'),
    );
    const reviewerText = normalizedText(
      detailedRole(host, 'Revisora independente'),
    );

    expect(coordinatorText).toMatch(
      /Ferramentas permitidas:? Sem lista restrita; este papel pode usar qualquer ferramenta disponível\./i,
    );
    expect(reviewerText).toMatch(
      /Habilidades permitidas:? Sem lista restrita; este papel pode usar qualquer habilidade disponível\./i,
    );
    expect(`${coordinatorText} ${reviewerText}`).not.toMatch(
      /limitado pelo tipo de trabalho/i,
    );
  });

  it.each(REVIEW_LANE_CASES)(
    'keeps $label and its authority effects outside the advanced review disclosure',
    ({ lane, label, authority }) => {
      const host = renderReadyReview(CUSTOM_REVIEW, lane);
      const reviewRegion = host.querySelector<HTMLElement>(
        '[aria-label="Revisão atual da missão"]',
      );
      const advanced = Array.from(
        reviewRegion?.querySelectorAll('details') ?? [],
      ).find(
        (item) => item.querySelector('summary')?.textContent?.trim() === 'Avançado',
      );
      const beginnerReview = reviewRegion?.cloneNode(true) as
        | HTMLElement
        | undefined;
      for (const disclosure of beginnerReview?.querySelectorAll('details') ?? []) {
        disclosure.remove();
      }
      const beginnerText = beginnerReview ? normalizedText(beginnerReview) : '';

      expect(reviewRegion).not.toBeNull();
      expect(advanced?.open).toBe(false);
      expect(beginnerText).toContain(label);
      for (const statement of authority) {
        expect(beginnerText).toMatch(statement);
      }
    },
  );

  it('labels each role authority as readable rows and translates tool IDs for beginners', () => {
    const authorityReview: MissionReview = {
      ...CUSTOM_REVIEW,
      roster: CUSTOM_REVIEW.roster.map((agent) =>
        agent.id === 'custom-interface-builder'
          ? { ...agent, allowedTools: ['Bash', 'Read', 'Edit'] }
          : agent,
      ),
    };
    const host = renderReadyReview(authorityReview);

    for (const roleName of [
      'Coordenadora de entrega',
      'Especialista de interface',
      'Revisora independente',
    ]) {
      const role = detailedRole(host, roleName);
      const authorityRows = Array.from(role.querySelectorAll('dl > div'));
      const labels = authorityRows.map(
        (row) => row.querySelector('dt')?.textContent?.trim() ?? '',
      );

      expect(authorityRows.length).toBeGreaterThanOrEqual(3);
      expect(labels).toEqual(
        expect.arrayContaining([
          'Instruções',
          'Ferramentas permitidas',
          'Habilidades permitidas',
        ]),
      );
      for (const row of authorityRows) {
        expect(row.firstElementChild?.tagName).toBe('DT');
        expect(row.lastElementChild?.tagName).toBe('DD');
      }
    }

    const builder = detailedRole(host, 'Especialista de interface');
    const toolRow = Array.from(builder.querySelectorAll('dl > div')).find(
      (row) =>
        row.querySelector('dt')?.textContent?.trim() ===
        'Ferramentas permitidas',
    );
    const beginnerTools = toolRow ? normalizedText(toolRow) : '';
    const beginnerRole = builder.cloneNode(true) as HTMLElement;
    for (const advanced of beginnerRole.querySelectorAll('details')) {
      advanced.remove();
    }

    expect(beginnerTools).toContain('Executar comandos');
    expect(beginnerTools).toContain('Ler arquivos');
    expect(beginnerTools).toContain('Editar arquivos');
    expect(normalizedText(beginnerRole)).not.toMatch(/\b(?:Bash|Read|Edit)\b/);
  });

  it('keeps the start action in a dock and shows objective, team and context in the beginner review', () => {
    const host = renderReadyReview({
      ...CUSTOM_REVIEW,
      contextPaths: ['src/renderer/App.tsx'],
    });
    const dock = host.querySelector('.mission-setup__step-dock');
    const reviewRegion = host.querySelector<HTMLElement>(
      '[aria-label="Revisão atual da missão"]',
    );
    const beginnerReview = reviewRegion?.cloneNode(true) as
      | HTMLElement
      | undefined;
    for (const disclosure of beginnerReview?.querySelectorAll('details') ?? []) {
      disclosure.remove();
    }
    const beginnerText = beginnerReview ? normalizedText(beginnerReview) : '';

    expect(dock).not.toBeNull();
    expect(dock?.contains(startButton(host))).toBe(true);
    expect(beginnerText).toContain(CUSTOM_REVIEW.objective);
    expect(beginnerText).toContain('Coordenadora de entrega');
    expect(beginnerText).toContain('src/renderer/App.tsx');
    expect(host.querySelector('.mission-review--pending')).toBeNull();
  });

  it.each([
    {
      prepareStatus: 'loading' as const,
      copy: /Montando o resumo da missão/i,
      retry: false,
    },
    {
      prepareStatus: 'idle' as const,
      copy: /revisão ainda não está visível/i,
      retry: false,
    },
    {
      prepareStatus: 'error' as const,
      copy: /revisão não está visível/i,
      retry: true,
    },
  ])(
    'shows an honest pending review when prepare is $prepareStatus instead of an empty desert',
    ({ prepareStatus, copy, retry }) => {
      const host = render(
        <ReviewStep
          review={null}
          lane="standard"
          prepareStatus={prepareStatus}
          startStatus="idle"
          error={
            prepareStatus === 'error' ? 'Falha ao preparar a revisão.' : null
          }
          onBack={vi.fn()}
          onRetryPrepare={vi.fn()}
          onStart={vi.fn()}
        />,
      );
      const pending = host.querySelector('.mission-review--pending');
      const start = startButton(host);

      expect(pending).not.toBeNull();
      expect(normalizedText(pending!)).toMatch(copy);
      expect(host.querySelector('[aria-label="Revisão atual da missão"]')).toBeNull();
      expect(start.disabled).toBe(true);
      expect(start.closest('.mission-setup__step-dock')).not.toBeNull();
      expect(
        Array.from(host.querySelectorAll('button')).some(
          (item) => item.textContent?.trim() === 'Preparar nova revisão',
        ),
      ).toBe(retry);
    },
  );
});
