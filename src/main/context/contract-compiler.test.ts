import { describe, expect, it } from 'vitest';
import { normalizeDomainLabel } from './contract-compiler';

describe('normalizeDomainLabel', () => {
  it('normalizes human-written domains instead of refusing the mission', () => {
    // Field trap (28/07): a goal written in Portuguese produced domains that
    // failed the identifier regex, and `impactedDomains.0: Invalid input`
    // killed the mission before any provider ran.
    expect(normalizeDomainLabel('área de login')).toBe('area-de-login');
    expect(normalizeDomainLabel('billing/efi')).toBe('billing-efi');
    expect(normalizeDomainLabel('notificação WhatsApp')).toBe(
      'notificacao-WhatsApp',
    );
    expect(normalizeDomainLabel('-leading-dash')).toBe('leading-dash');
  });

  it('leaves an already-valid identifier untouched', () => {
    expect(normalizeDomainLabel('auth')).toBe('auth');
    expect(normalizeDomainLabel('api.v2:users')).toBe('api.v2:users');
  });

  it('reports labels that carry no identifier at all', () => {
    expect(normalizeDomainLabel('***')).toBeNull();
    expect(normalizeDomainLabel('   ')).toBeNull();
  });
});
import type { ProjectExecutionScope } from '../../shared/types';
import {
  compileMissionContract,
  ContractCompilationError,
} from './contract-compiler';
import {
  decideDesignAuthority,
  isUiMissionText,
} from '../../shared/mission-work-kind';

const scope: ProjectExecutionScope = Object.freeze({
  version: 1,
  installationId: 'install-a',
  projectId: 'project-a',
  checkoutId: 'checkout-a',
  rootRealPath: '/workspace/a',
  identitySource: 'manifest',
});

function proposal() {
  return {
    schemaVersion: 1 as const,
    scope,
    missionId: 'mission-a',
    baseCommit: 'a'.repeat(40),
    contextRevision: 'context-001',
    goal: 'Adicionar autenticação sem quebrar a sessão existente',
    nonGoals: ['Trocar o provedor de identidade'],
    acceptanceCriteria: [
      {
        id: 'ac-login',
        statement: 'Login válido cria uma sessão',
        requiredSensorIds: ['unit'],
      },
    ],
    businessInvariantRefs: ['inv-session'],
    impactedDomains: ['auth'],
    impactedSymbols: ['createSession'],
    requestedSensors: ['unit'],
    requiredArtifacts: [],
    riskHints: ['auth'],
  };
}

const context = {
  invariantRefs: new Set(['inv-session']),
  availableSensorIds: new Set(['unit', 'typecheck', 'design-system']),
  blockingConflictIds: [] as string[],
};

describe('compileMissionContract', () => {
  it('elevates risky business domains and emits one deterministic frozen hash', () => {
    const first = compileMissionContract(proposal(), context);
    const second = compileMissionContract(proposal(), context);

    expect(first.risk).toBe('high');
    expect(first.requiredSensors).toEqual(['unit']);
    expect(first.route).toEqual([
      'planning',
      'review-primary',
      'execution',
      'validation-primary',
      'confirmation',
    ]);
    expect(first.contractHash).toMatch(/^[a-f0-9]{64}$/);
    expect(first.contractHash).toBe(second.contractHash);
    expect(Object.isFrozen(first)).toBe(true);
  });

  it('makes ordering of set-like inputs irrelevant to the contract hash', () => {
    const left = proposal();
    left.impactedDomains = ['ipc', 'auth'];
    left.requestedSensors = ['typecheck', 'unit'];
    const right = proposal();
    right.impactedDomains = ['auth', 'ipc'];
    right.requestedSensors = ['unit', 'typecheck'];

    expect(compileMissionContract(left, context).contractHash).toBe(
      compileMissionContract(right, context).contractHash,
    );
  });

  it('keeps explicit unresolved requirements pending instead of producing false green', () => {
    // Explicit acceptance requirements are contract authority. If Nexus cannot
    // resolve one yet, it must stay visible and prevent final promotion rather
    // than silently weakening the contract.
    const withoutInvariants = compileMissionContract(proposal(), {
      ...context,
      invariantRefs: new Set(),
    });
    expect(withoutInvariants.businessInvariantRefs).toEqual(['inv-session']);

    const withoutSensors = compileMissionContract(proposal(), {
      ...context,
      availableSensorIds: new Set(),
    });
    expect(withoutSensors.requiredSensors).toEqual(['unit']);
  });

  it('still fails closed on a blocking context conflict', () => {
    // A conflict is contradictory evidence about the repo, not a missing
    // label. Coding against it would produce confidently wrong work, so this
    // gate stays hard.
    expect(() =>
      compileMissionContract(proposal(), {
        ...context,
        blockingConflictIds: ['conflict-a'],
      }),
    ).toThrow(/blocking context conflict/i);
    expect(() =>
      compileMissionContract(proposal(), {
        ...context,
        blockingConflictIds: ['conflict-a'],
      }),
    ).toThrow(ContractCompilationError);
  });

  it('rejects caller-declared low risk when automatic signals require critical', () => {
    const input = proposal();
    input.riskHints = ['payment', 'tenant-isolation'];

    const contract = compileMissionContract(input, context);
    expect(contract.risk).toBe('critical');
    expect(contract.route).toContain('review-secondary');
    expect(contract.route).toContain('validation-secondary');
  });

  it('classifies Portuguese authentication and permission work as high risk', () => {
    const input = proposal();
    input.goal = 'Corrigir autenticação e permissões sem invalidar a sessão';
    input.riskHints = [];
    input.impactedDomains = [];

    expect(compileMissionContract(input, context).risk).toBe('high');
  });

  it('classifies Portuguese payment and billing work as critical risk', () => {
    const input = proposal();
    input.goal = 'Implementar pagamento, cobrança e reembolso';
    input.riskHints = [];
    input.impactedDomains = [];

    expect(compileMissionContract(input, context).risk).toBe('critical');
  });

  it('automatically makes design-system consistency executable for UI missions', () => {
    const input = proposal();
    input.goal = 'Criar uma landing page responsiva com identidade própria';
    input.impactedDomains = ['frontend'];

    const contract = compileMissionContract(input, context);

    expect(contract.requiredSensors).toContain('design-system');

    // Field trap (28/07): `design-system` is auto-injected, so a project that
    // never registered that sensor had EVERY UI mission refused at compile
    // time by a requirement the operator never asked for and could not see.
    // It is now dropped, and the UI mission runs.
    const withoutDesignSystem = compileMissionContract(input, {
      ...context,
      availableSensorIds: new Set(['unit', 'typecheck']),
    });
    expect(withoutDesignSystem.requiredSensors).not.toContain('design-system');
  });
});

/**
 * THE HARD COHERENCE RULE (C2).
 *
 * Whoever REQUIRES the `design-system` sensor must be whoever CREATES the
 * design contract. Before this, the compiler owned a private `UI_SIGNAL` regex
 * and `buildDesignContractBootstrap` owned `classifyWorkKind`, and they
 * disagreed on the most common product goal there is:
 *
 *   "implementar o CRUD de usuários com paginação"
 *     compiler  → UI_SIGNAL matched (`pagina` INSIDE `paginação`: `ç` is not a
 *                 `\w`, so the `\b` closed right there) → design-system REQUIRED
 *     bootstrap → classifyWorkKind said feature/high     → contract REFUSED
 *
 * Net effect on a backend CRUD: a required sensor with nothing to check, a
 * worker with no design clause (so it also lost the anti-slop line), and a
 * merge blocked by an English JSON nobody asked for.
 *
 * Both ends now call `decideDesignAuthority`. The table below is the proof,
 * over real goals in pt-BR and English, that the two answers are the SAME
 * answer — not two rules that happen to agree today.
 */
describe('design-system sensor ⟺ design contract (one predicate)', () => {
  /** Criterion statement = goal, no domains: both ends read the same corpus. */
  function proposalForGoal(goal: string) {
    return {
      ...proposal(),
      goal,
      impactedDomains: [],
      riskHints: [],
      requestedSensors: ['unit'],
      acceptanceCriteria: [
        { id: 'ac-1', statement: goal, requiredSensorIds: ['unit'] },
      ],
    };
  }

  const GOALS = [
    // ── pt-BR, must NOT get design authority ──────────────────────────────
    'implementar o CRUD de usuários com paginação',
    'refatorar o core do serviço de pagamento',
    'extrair o core da engine para um pacote',
    'implementar o design pattern repository no backend',
    'implementar cache no serviço de imagens',
    'documentar o esquema de cores do log',
    'corrigir o bug da tela de erro que trava o backend',
    'melhorar a performance do dashboard',
    'configurar o backup do servidor de staging',
    'Criar desktop pet v2, avatar e spritesheet animada com QA visual',
    // ── pt-BR, must GET design authority ──────────────────────────────────
    'redesenhar a tela de cobrança',
    'trocar as cores do tema',
    'criar a nova tela de cobrança',
    'Criar landing page inspirada em https://stripe.com',
    'melhorar a acessibilidade do dashboard',
    'ajustar a tipografia e o espaçamento do painel de agentes',
    // ── English ───────────────────────────────────────────────────────────
    'implement the CRUD of users with pagination',
    'refactor the core of the payment service',
    'fix the crash on startup',
    'redesign the landing page',
    'add a dark mode toggle to the settings screen',
    'improve the accessibility of the metrics dashboard',
  ] as const;

  it.each(GOALS)(
    'the sensor is required exactly when the contract is created: %j',
    (goal) => {
      const contract = compileMissionContract(proposalForGoal(goal), context);
      const sensorRequired = contract.requiredSensors.includes('design-system');

      // The bootstrap pilot's FIRST gate, called verbatim.
      const contractCreated = decideDesignAuthority(goal).required;

      expect(sensorRequired).toBe(contractCreated);
    },
  );

  it('never demands the sensor for the goal that started this', () => {
    const contract = compileMissionContract(
      proposalForGoal('implementar o CRUD de usuários com paginação'),
      context,
    );
    expect(contract.requiredSensors).toEqual(['unit']);
    expect(decideDesignAuthority('implementar o CRUD de usuários com paginação'))
      .toMatchObject({ required: false, refusal: 'not-visual-work' });
  });

  it('a mission that gets the sensor also gets the design skills', () => {
    // The third leg: no goal may carry a design obligation while its roster is
    // told nothing about design. (`isUiMissionText` is what
    // `isGuidedUiMissionObjective` delegates to.)
    for (const goal of GOALS) {
      if (decideDesignAuthority(goal).required) {
        expect(isUiMissionText(goal)).toBe(true);
      }
    }
  });

  it('still injects the sensor only when the project registered it', () => {
    const input = proposalForGoal('redesenhar a tela de cobrança');
    expect(
      compileMissionContract(input, context).requiredSensors,
    ).toContain('design-system');
    expect(
      compileMissionContract(input, {
        ...context,
        availableSensorIds: new Set(['unit', 'typecheck']),
      }).requiredSensors,
    ).not.toContain('design-system');
  });
});
