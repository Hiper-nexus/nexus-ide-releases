import { describe, expect, it } from 'vitest';
import type { Mission } from '../../shared/orch-types';
import { testProjectScope } from './__tests__/scope-fixture';
import {
  getAutomaticCompletionProof,
  isAutomaticCompletionProof,
  withAutomaticCompletionProof,
  type AutomaticCompletionProof,
} from './automatic-completion-proof';
import { evaluateIndependentReviewGate } from './mission-independent-review-gate';

const scope = testProjectScope({
  workspaceRootDevice: 'device-a',
  workspaceRootInode: 'inode-a',
});
const mission = {
  id: 'reviewed',
  intentVersion: 2,
  updatedAt: 10,
  intentState: 'executing' as const,
};
const proofInput: AutomaticCompletionProof = {
  status: 'verified',
  candidateFingerprint: 'physical-candidate',
};

/**
 * Teste ao extremo do guard de identidade dos proofs main-owned de conclusão
 * automática (F-134/F-137). O proof só existe DENTRO da fronteira síncrona que
 * o registrou; qualquer cópia, clone, prova de outra missão/escopo ou mutação
 * posterior precisa falhar — senão uma entrega anunciada como "verificada"
 * poderia ser fabricada ou corrompida após a checagem.
 */
describe('automatic completion proof — life-cycle extremo', () => {
  it('restaura o proof externo quando um registro aninhado (mesma chave) encerra normalmente', () => {
    const outerProof = { ...proofInput, candidateFingerprint: 'outer-candidate' };
    let outerStored: AutomaticCompletionProof | null = null;
    const result = withAutomaticCompletionProof(scope, mission, outerProof, () => {
      outerStored = getAutomaticCompletionProof(scope, mission);
      expect(outerStored).toEqual(outerProof);
      const innerResult = withAutomaticCompletionProof(
        scope,
        mission,
        { status: 'unavailable', note: 'inner shadow' },
        () => {
          const innerStored = getAutomaticCompletionProof(scope, mission);
          expect(innerStored?.status).toBe('unavailable');
          // O proof do outer continua ativo na mesma chave, mas agora oculto.
          expect(isAutomaticCompletionProof(innerStored, scope, mission)).toBe(true);
          return true;
        },
      );
      expect(innerResult).toBe(true);
      // Ao sair do inner, o proof do outer volta a ser o ativo — mesma identidade.
      expect(getAutomaticCompletionProof(scope, mission)).toBe(outerStored);
      expect(getAutomaticCompletionProof(scope, mission)?.status).toBe('verified');
      return true;
    });
    expect(result).toBe(true);
    expect(getAutomaticCompletionProof(scope, mission)).toBeNull();
  });

  it('restaura o proof externo quando um registro aninhado LANÇA e o outer captura', () => {
    let outerStored: AutomaticCompletionProof | null = null;
    let caught: string | null = null;
    const result = withAutomaticCompletionProof(scope, mission, proofInput, () => {
      outerStored = getAutomaticCompletionProof(scope, mission);
      try {
        withAutomaticCompletionProof(
          scope,
          mission,
          { status: 'unavailable', note: 'inner that throws' },
          () => {
            expect(getAutomaticCompletionProof(scope, mission)?.status).toBe('unavailable');
            throw new Error('inner boom');
          },
        );
      } catch (error) {
        caught = error instanceof Error ? error.message : String(error);
      }
      // A falha do inner NÃO pode destruir o proof externo: ele decide a conclusão.
      expect(getAutomaticCompletionProof(scope, mission)).toBe(outerStored);
      expect(getAutomaticCompletionProof(scope, mission)?.status).toBe('verified');
      return true;
    });
    expect(caught).toBe('inner boom');
    expect(result).toBe(true);
    expect(getAutomaticCompletionProof(scope, mission)).toBeNull();
  });

  it('não vaza proof algum quando a exceção atravessa o outer (sem captura)', () => {
    expect(() =>
      withAutomaticCompletionProof(scope, mission, proofInput, () => {
        expect(getAutomaticCompletionProof(scope, mission)).not.toBeNull();
        throw new Error('outer boom');
      }),
    ).toThrow('outer boom');
    expect(getAutomaticCompletionProof(scope, mission)).toBeNull();
    expect(isAutomaticCompletionProof(proofInput)).toBe(false);
  });

  it('mantém duas missões ativas estritamente isoladas e nunca intercambiáveis', () => {
    const missionA = { id: 'mission-a', intentVersion: 1, updatedAt: 1, intentState: 'executing' as const };
    const missionB = { id: 'mission-b', intentVersion: 1, updatedAt: 2, intentState: 'executing' as const };
    withAutomaticCompletionProof(scope, missionA, { status: 'verified' }, () => {
      const proofA = getAutomaticCompletionProof(scope, missionA);
      return withAutomaticCompletionProof(scope, missionB, { status: 'unavailable', note: 'b' }, () => {
        const proofB = getAutomaticCompletionProof(scope, missionB);
        // Cada chave mantém o próprio proof simultaneamente.
        expect(getAutomaticCompletionProof(scope, missionA)).toBe(proofA);
        expect(getAutomaticCompletionProof(scope, missionB)).toBe(proofB);
        // O guard com escopo+missão jamais aceita o proof da outra missão.
        expect(isAutomaticCompletionProof(proofB, scope, missionA)).toBe(false);
        expect(isAutomaticCompletionProof(proofA, scope, missionB)).toBe(false);
        // A forma sem escopo enxerga ambos por identidade enquanto ativos.
        expect(isAutomaticCompletionProof(proofA)).toBe(true);
        expect(isAutomaticCompletionProof(proofB)).toBe(true);
        return true;
      });
    });
    expect(getAutomaticCompletionProof(scope, missionA)).toBeNull();
    expect(getAutomaticCompletionProof(scope, missionB)).toBeNull();
  });

  it('isola por identidade física do escopo — device, install, projeto, raiz e identitySource', () => {
    withAutomaticCompletionProof(scope, mission, proofInput, () => {
      expect(getAutomaticCompletionProof(scope, mission)).not.toBeNull();
      expect(getAutomaticCompletionProof({ ...scope, workspaceRootDevice: 'device-b' }, mission)).toBeNull();
      expect(getAutomaticCompletionProof({ ...scope, workspaceRootInode: 'inode-b' }, mission)).toBeNull();
      expect(getAutomaticCompletionProof({ ...scope, installationId: 'other-install' }, mission)).toBeNull();
      expect(getAutomaticCompletionProof({ ...scope, projectId: 'other-project' }, mission)).toBeNull();
      expect(getAutomaticCompletionProof({ ...scope, rootRealPath: '/other' }, mission)).toBeNull();
      expect(getAutomaticCompletionProof({ ...scope, identitySource: 'provisional' }, mission)).toBeNull();
      return true;
    });
  });

  it('congela o proof e o array de caminhos apagados — mutação posterior não altera a decisão', () => {
    const paths = ['src/a.ts', 'src/b.ts'];
    const input: AutomaticCompletionProof = {
      status: 'verified',
      candidateFingerprint: 'fp',
      deletedArtifactPaths: paths,
    };
    withAutomaticCompletionProof(scope, mission, input, () => {
      const stored = getAutomaticCompletionProof(scope, mission);
      expect(stored).not.toBeNull();
      const frozen = stored as AutomaticCompletionProof;
      paths.push('src/c.ts'); // mutação do array de QUEM CHAMOU, depois do registro
      expect(frozen.deletedArtifactPaths).toEqual(['src/a.ts', 'src/b.ts']);
      expect(Object.isFrozen(frozen)).toBe(true);
      expect(Object.isFrozen(frozen.deletedArtifactPaths)).toBe(true);
      // Modo estrito (ESM): mutar o proof congelado lança TypeError.
      expect(() => {
        (frozen as { status?: string }).status = 'unavailable';
      }).toThrow(TypeError);
      expect(() => {
        (frozen.deletedArtifactPaths as string[]).push('evil');
      }).toThrow(TypeError);
      return true;
    });
  });

  it('rejeita valores não-objeto no guard tipado', () => {
    expect(isAutomaticCompletionProof(null, scope, mission)).toBe(false);
    expect(isAutomaticCompletionProof(undefined, scope, mission)).toBe(false);
    expect(isAutomaticCompletionProof('proof', scope, mission)).toBe(false);
    expect(isAutomaticCompletionProof(42, scope, mission)).toBe(false);
    expect(isAutomaticCompletionProof({ status: 'verified' })).toBe(false);
  });

  it('gate: apenas o proof vivo (por identidade) verdeja — spread e structuredClone falham', () => {
    const gateMission = {
      id: 'reviewed',
      squadId: 'squad-1',
      status: 'running',
      description: 'Entrega real',
      intentState: 'executing',
      intentVersion: 2,
      updatedAt: 10,
      orchestratorSessionId: 'orch-1',
      intentContract: { lane: 'standard' } as Mission['intentContract'],
    } as unknown as Pick<
      Mission,
      'id' | 'squadId' | 'intentContract' | 'orchestratorSessionId' | 'intentState' | 'intentVersion' | 'updatedAt'
    >;
    const input = {
      scope,
      mission: gateMission,
      squad: { id: 'squad-1', agents: [] },
      handoffs: [],
      deliveryAttemptsOf: () => [],
    };
    // Sem proof, a conclusão falha (verificação automática obrigatória).
    expect(evaluateIndependentReviewGate(input).ok).toBe(false);
    withAutomaticCompletionProof(scope, mission, proofInput, () => {
      const live = getAutomaticCompletionProof(scope, mission);
      expect(live).not.toBeNull();
      expect(evaluateIndependentReviewGate({ ...input, automaticProof: live }))
        .toEqual({ ok: true, reviewerHandoffId: 'main-automatic-verification' });
      // Um clone raso ou profundo de um proof LEGÍTIMO não é o proof: a cadeia
      // de entrega (IPC/serialização) nunca pode forjar a verificação.
      expect(evaluateIndependentReviewGate({ ...input, automaticProof: { ...live } }).ok).toBe(false);
      expect(evaluateIndependentReviewGate({
        ...input,
        automaticProof: structuredClone(live),
      }).ok).toBe(false);
      return true;
    });
    expect(getAutomaticCompletionProof(scope, mission)).toBeNull();
  });
});
