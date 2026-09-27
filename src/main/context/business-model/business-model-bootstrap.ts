import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { ProjectExecutionScope } from '../../../shared/types';
import { resolveProjectExecutionScopeCached } from '../../persistence/project-identity';
import type { ContextKnowledgeService } from '../context-knowledge-service';
import { getContextKnowledgeService } from '../context-workflow-registry';
import { BUSINESS_MODEL_TARGET_PATH } from './business-model-contract';
import {
  BUSINESS_MODEL_MARKER_LINE,
  extractBusinessModel,
  type BusinessModelExtraction,
} from './business-model-extract';

/**
 * Ramo do bootstrap do `.context` que mantém `.context/docs/business-model.md`
 * em dia com as fontes. Mesmo padrão do contrato de design: o doc é uma função
 * pura das fontes, então o revisor é uma identidade Nexus DISTINTA do autor que
 * re-deriva do zero (sem cache) e só aprova bytes idênticos. Apply e commit
 * seguem separados (o commit continua com o autopilot).
 */

export const BUSINESS_MODEL_EXTRACTOR = Object.freeze({
  id: 'nexus-business-model-extractor',
  sessionId: 'deterministic-extract-v1',
  provider: 'nexus-extractor',
});
const BUSINESS_MODEL_MECHANICAL_REVIEWER = Object.freeze({
  id: 'nexus-business-model-reviewer',
  sessionId: 'deterministic-rederive-v1',
  provider: 'nexus-mechanical-review',
});

/** Cabeçalhos dos docs que o próprio bootstrap já gerava: podem ser substituídos. */
const REPLACEABLE_HEADERS = [
  BUSINESS_MODEL_MARKER_LINE,
  '> Source-bound product context copied from',
  '> Auto-proposed skeleton from orientation',
];

export type BusinessModelKnowledge = Pick<
  ContextKnowledgeService,
  'list' | 'get' | 'propose' | 'review' | 'apply'
>;

export interface BusinessModelBootstrapOutcome {
  readonly targetPath: string;
  readonly status:
    | 'applied'
    | 'up-to-date'
    | 'proposed'
    | 'rejected'
    | 'skipped'
    | 'failed';
  readonly draftId: string | null;
  readonly flows: number;
  readonly invariants: number;
  readonly message: string;
}

export interface BusinessModelBootstrapInput {
  readonly scope: ProjectExecutionScope;
  readonly knowledge: BusinessModelKnowledge;
  readonly missionId?: string | null;
  /** Seam de teste: extração (a revisão chama com `fresh: true`). */
  readonly extract?: (root: string, options: { fresh?: boolean }) => BusinessModelExtraction | null;
}

function outcome(
  status: BusinessModelBootstrapOutcome['status'],
  message: string,
  extraction: BusinessModelExtraction | null,
  draftId: string | null = null,
): BusinessModelBootstrapOutcome {
  return Object.freeze({
    targetPath: BUSINESS_MODEL_TARGET_PATH,
    status,
    draftId,
    flows: extraction?.document.flows.length ?? 0,
    invariants: extraction?.document.invariants.length ?? 0,
    message,
  });
}

function readTarget(root: string): { content: string; hash: string } | null {
  try {
    const absolute = path.join(root, BUSINESS_MODEL_TARGET_PATH);
    const stat = fs.lstatSync(absolute);
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    const bytes = fs.readFileSync(absolute);
    return {
      content: bytes.toString('utf8'),
      hash: createHash('sha256').update(bytes).digest('hex'),
    };
  } catch {
    return null;
  }
}

function sameProposal(
  left: BusinessModelExtraction['proposal'],
  right: { content: string; sources: readonly { locator: string; sourceHash: string }[] },
): boolean {
  return left.content === right.content &&
    left.sources.length === right.sources.length &&
    left.sources.every((source, index) =>
      source.locator === right.sources[index]?.locator &&
      source.sourceHash === right.sources[index]?.sourceHash);
}

export function runBusinessModelBootstrap(
  input: BusinessModelBootstrapInput,
): BusinessModelBootstrapOutcome {
  const root = input.scope.rootRealPath;
  const extract = input.extract ?? ((dir, options) => extractBusinessModel(dir, options));
  let extraction: BusinessModelExtraction | null = null;
  try {
    extraction = extract(root, {});
    if (!extraction) {
      return outcome('skipped', 'Sem fontes versionadas de regra de negócio (SQL com fluxo, AGENTS.md, specs) para extrair.', null);
    }
    const { proposal } = extraction;
    const current = readTarget(root);
    if (current?.content === proposal.content) {
      return outcome('up-to-date', 'Modelo de negócio em dia com as fontes.', extraction);
    }
    if (current && !REPLACEABLE_HEADERS.some((header) => current.content.includes(header))) {
      return outcome(
        'skipped',
        `${BUSINESS_MODEL_TARGET_PATH} foi escrito à mão; o Nexus não o sobrescreve. Renomeie-o para receber o modelo extraído.`,
        extraction,
      );
    }
    const active = [
      ...input.knowledge.list({ status: 'proposed' }),
      ...input.knowledge.list({ status: 'approved' }),
    ].find((draft) => draft.targetPath === BUSINESS_MODEL_TARGET_PATH);
    let draftId: string;
    if (active) {
      if (active.author.id !== BUSINESS_MODEL_EXTRACTOR.id || !sameProposal(proposal, active)) {
        return outcome('skipped', 'Outro draft ativo já ocupa o modelo de negócio; o Nexus não disputa o alvo.', extraction);
      }
      draftId = active.id;
    } else {
      draftId = input.knowledge.propose(
        {
          missionId: input.missionId ?? null,
          targetPath: proposal.targetPath,
          content: proposal.content,
          expectedTargetHash: current?.hash ?? null,
          sources: proposal.sources,
        },
        BUSINESS_MODEL_EXTRACTOR,
      ).id;
    }
    const draft = input.knowledge.get(draftId);
    if (draft?.status === 'proposed') {
      // Revisão independente: re-deriva do zero e exige os mesmos bytes e fontes.
      const reDerived = extract(root, { fresh: true });
      if (!reDerived || !sameProposal(reDerived.proposal, draft)) {
        input.knowledge.review(draftId, {
          decision: 'reject',
          reviewer: BUSINESS_MODEL_MECHANICAL_REVIEWER,
          rationale: 'Rejeitado pela revisão mecânica: a re-extração das fontes não reproduziu estes bytes.',
        });
        return outcome('rejected', 'A re-extração não reproduziu o draft; nova tentativa na próxima passada.', extraction, draftId);
      }
      input.knowledge.review(draftId, {
        decision: 'approve',
        reviewer: BUSINESS_MODEL_MECHANICAL_REVIEWER,
        rationale:
          `Aprovado por re-derivação determinística: ${draft.sources.length} fonte(s) versionada(s) ` +
          'reextraídas do zero produzem bytes idênticos; cada regra cita arquivo:linha.',
      });
    }
    input.knowledge.apply(draftId);
    return outcome(
      'applied',
      `Modelo de negócio aplicado: ${extraction.document.flows.length} fluxo(s), ${extraction.document.invariants.length} invariante(s).`,
      extraction,
      draftId,
    );
  } catch (error) {
    return outcome('failed', error instanceof Error ? error.message : String(error), extraction);
  }
}

/** Chamado por `business-model-refresh` depois de confirmar `.context/docs`. */
export function refreshBusinessModelForWorkspace(workspacePath: string): void {
  try {
    const scope = resolveProjectExecutionScopeCached(workspacePath);
    const result = runBusinessModelBootstrap({
      scope,
      knowledge: getContextKnowledgeService(scope),
    });
    if (result.status === 'failed') console.warn('[business-model] refresh failed:', result.message);
  } catch (error) {
    console.warn('[business-model] refresh unavailable:', error instanceof Error ? error.message : String(error));
  }
}
