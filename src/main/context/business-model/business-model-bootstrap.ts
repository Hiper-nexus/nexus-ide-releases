import type { ProjectExecutionScope } from '../../../shared/types';
import type { ContextKnowledgeService } from '../context-knowledge-service';
import {
  BUSINESS_MODEL_EXTRACTOR_ID,
  BUSINESS_MODEL_TARGET_PATH,
  findBusinessModelAttestation,
  readBusinessModelTarget,
} from './business-model-contract';
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
  id: BUSINESS_MODEL_EXTRACTOR_ID,
  sessionId: 'deterministic-extract-v1',
  provider: 'nexus-extractor',
});
const BUSINESS_MODEL_MECHANICAL_REVIEWER = Object.freeze({
  id: 'nexus-business-model-reviewer',
  sessionId: 'deterministic-rederive-v1',
  provider: 'nexus-mechanical-review',
});

/**
 * Cabeçalhos dos docs que o próprio bootstrap já gerava sem conteúdo real: podem
 * ser substituídos. A cópia source-bound do PRODUCT.md NÃO entra: é contexto de
 * produto revisado (clientes, preço, tenancy) que o modelo extraído não repõe.
 */
const REPLACEABLE_HEADERS = [
  BUSINESS_MODEL_MARKER_LINE,
  '> Auto-proposed skeleton from orientation',
];

export type BusinessModelKnowledge = Pick<
  ContextKnowledgeService,
  'get' | 'propose' | 'review' | 'apply' | 'activeForTarget' | 'supersedeActiveForTarget'
>;

export interface BusinessModelBootstrapOutcome {
  readonly targetPath: string;
  readonly status: 'applied' | 'up-to-date' | 'rejected' | 'skipped' | 'failed';
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
  readonly extract?: (
    root: string,
    options: { fresh?: boolean },
  ) => Promise<BusinessModelExtraction | null> | BusinessModelExtraction | null;
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

function sameSources(
  left: readonly { locator: string; sourceHash: string }[],
  right: readonly { locator: string; sourceHash: string }[],
): boolean {
  return left.length === right.length &&
    left.every((source, index) =>
      source.locator === right[index]?.locator &&
      source.sourceHash === right[index]?.sourceHash);
}

function sameProposal(
  left: BusinessModelExtraction['proposal'],
  right: { content: string; sources: readonly { locator: string; sourceHash: string }[] },
): boolean {
  return left.content === right.content && sameSources(left.sources, right.sources);
}

export async function runBusinessModelBootstrap(
  input: BusinessModelBootstrapInput,
): Promise<BusinessModelBootstrapOutcome> {
  const root = input.scope.rootRealPath;
  const extract = input.extract ?? ((dir, options) => extractBusinessModel(dir, options));
  let extraction: BusinessModelExtraction | null = null;
  try {
    extraction = await extract(root, {});
    if (!extraction) {
      return outcome('skipped', 'Sem fontes versionadas de regra de negócio (SQL com fluxo, AGENTS.md, specs) para extrair.', null);
    }
    if (extraction.pendingSources.length > 0) {
      // Sem essas fontes o modelo sairia "completo" sem fluxos/testes/chamadores
      // que o portão de regressão precisa: adia e mantém o doc anterior.
      const shown = extraction.pendingSources.slice(0, 5).join(', ');
      const more = extraction.pendingSources.length > 5 ? ` e mais ${extraction.pendingSources.length - 5}` : '';
      return outcome(
        'skipped',
        `Modelo de negócio adiado: fonte(s) do modelo com alteração local não commitada (${shown}${more}). ` +
          'O modelo anterior fica valendo até elas serem commitadas.',
        extraction,
      );
    }
    const { proposal } = extraction;
    const current = readBusinessModelTarget(input.scope);
    if (current?.content === proposal.content) {
      // Mesmo texto não basta: a atestação precisa citar as fontes ATUAIS
      // (um comentário novo na migration muda o hash sem mudar o doc).
      const attestation = findBusinessModelAttestation(input.scope, current.hash);
      if (attestation && sameSources(attestation.sources, proposal.sources)) {
        return outcome('up-to-date', 'Modelo de negócio em dia com as fontes.', extraction);
      }
    } else if (current && !REPLACEABLE_HEADERS.some((header) => current.content.includes(header))) {
      return outcome(
        'skipped',
        `${BUSINESS_MODEL_TARGET_PATH} foi escrito à mão (ou copiado do PRODUCT.md); o Nexus não o sobrescreve. ` +
          'Renomeie-o para receber o modelo extraído.',
        extraction,
      );
    }
    let active = input.knowledge.activeForTarget(BUSINESS_MODEL_TARGET_PATH);
    if (active && active.author.id !== BUSINESS_MODEL_EXTRACTOR.id) {
      return outcome('skipped', 'Outro draft ativo já ocupa o modelo de negócio; o Nexus não disputa o alvo.', extraction);
    }
    if (active && !sameProposal(proposal, active)) {
      // Draft do próprio extrator que ficou para trás (apply falhou, fontes
      // mudaram): sem superá-lo o alvo ficaria travado para sempre.
      input.knowledge.supersedeActiveForTarget(BUSINESS_MODEL_TARGET_PATH);
      active = null;
    }
    const draftId = active
      ? active.id
      : input.knowledge.propose(
          {
            missionId: input.missionId ?? null,
            targetPath: proposal.targetPath,
            content: proposal.content,
            expectedTargetHash: current?.hash ?? null,
            sources: proposal.sources,
          },
          BUSINESS_MODEL_EXTRACTOR,
        ).id;
    const draft = input.knowledge.get(draftId);
    if (draft?.status === 'proposed') {
      // Revisão independente: re-deriva do zero e exige os mesmos bytes e fontes.
      const reDerived = await extract(root, { fresh: true });
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
