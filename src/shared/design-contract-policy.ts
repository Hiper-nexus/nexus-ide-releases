import type { DesignAuthorityRefusal } from './mission-work-kind';

/**
 * WHAT THE OPERATOR IS TOLD WHEN THE DESIGN PILOT DECIDES SOMETHING.
 *
 * WHY THIS MODULE EXISTS (H4 + H6)
 * --------------------------------
 * H4 was a deadlock built out of two answers to one question:
 *
 *   - `buildDesignContractBootstrap` CREATED a contract only for `visual` with
 *     HIGH confidence;
 *   - `planGuidedWorkGraph` DEMANDED one for ANY `visual` verdict, confidence
 *     ignored, and that verdict reached the executor contract as "block with
 *     `design_contract_missing` if no contract exists".
 *
 * So `"trocar a cor do botão de aprovar"` (measured: `visual` / `low`) got NO
 * contract and an executor ordered to block for the lack of one. A deadlock on
 * the most trivial task in the product, by construction.
 *
 * THE POLICY, AND WHY THIS ONE
 * ----------------------------
 * There is now exactly ONE predicate — `decideDesignAuthority`
 * (src/shared/mission-work-kind.ts) — and every end calls it: the contract
 * compiler that REQUIRES the `design-system` sensor, the bootstrap pilot that
 * WRITES the contract, and the work graph that decides whether a task may
 * DEMAND one. This module deliberately does NOT define a second predicate; it
 * only turns that one decision into words.
 *
 * The chosen policy is fail-CLOSED on writing authority and fail-OPEN on the
 * obligation:
 *
 *   - Low confidence never MATERIALIZES a contract. `classifyWorkKind` says so
 *     itself: "Confianca baixa — trate como pista, nao como decisao." Weak
 *     evidence would hang a durable DESIGN.md on a mission that is not visual
 *     at all — `"melhorar a performance do dashboard"` reads `visual`/`low`
 *     purely on the locative noun `dashboard`.
 *   - Low confidence therefore never DEMANDS one either. Requiring an authority
 *     that the same evidence forbids creating IS the deadlock; "create it
 *     anyway" would only move the damage from the mission to the repository,
 *     where every later task then defends a false identity.
 *
 * The residual is deliberate and small: a genuinely visual low-confidence goal
 * writes CSS with no design clause. That is proportionate — a localized change
 * to an existing surface, not a new one — and the operator is told, in words,
 * that it happened and how to get a contract if the goal really was a UI build.
 *
 * WHY THE PROSE LIVES IN `src/shared` (H6)
 * ----------------------------------------
 * The skip reasons used to be enum tokens that died inside an MCP payload: zero
 * occurrences anywhere in `src/renderer`, `src/preload` or `src/shared`. This
 * is the only layer both the main process and the renderer may import, so the
 * sentences live here and every surface quotes the same text.
 *
 * Pure: no I/O, no clock, no randomness.
 */

export const DESIGN_CONTRACT_SKIP_REASONS = [
  /** No mission goal reached the pilot, so there was nothing to classify. */
  'no-goal',
  /** `decideDesignAuthority` refused: the goal is not visual work. */
  'not-visual-work',
  /** Visual, but the evidence is a hint, not a decision. */
  'low-confidence',
  /** Visual ASSET work: no interface for a token contract to govern. */
  'asset-not-interface',
  /** DESIGN.md or the target path already holds authority. */
  'contract-exists',
  /** Nothing in the workspace can be hashed as evidence. */
  'no-bindable-source',
  /** Another author owns an active draft for the same target. */
  'foreign-active-draft',
] as const;

export type DesignContractSkipReason =
  (typeof DESIGN_CONTRACT_SKIP_REASONS)[number];

/** Reasons the build step itself can return (the pilot adds the last one). */
export type DesignContractBuildSkipReason = Exclude<
  DesignContractSkipReason,
  'foreign-active-draft'
>;

/**
 * Maps the shared predicate's refusal onto the pilot's skip vocabulary. A
 * mapping, never a second opinion: if `decideDesignAuthority` grows a refusal,
 * this switch stops compiling instead of silently swallowing it.
 */
export function designContractSkipReasonForRefusal(
  refusal: DesignAuthorityRefusal,
): DesignContractBuildSkipReason {
  switch (refusal) {
    case 'not-visual-work':
      return 'not-visual-work';
    case 'low-confidence':
      return 'low-confidence';
    case 'asset-not-interface':
      return 'asset-not-interface';
  }
}

export interface DesignContractSkipNarrationInput {
  readonly reason: DesignContractSkipReason;
  readonly targetPath: string;
  /** `classifyWorkKind` verdict kind, when there was a goal to classify. */
  readonly workKind?: string | null;
  /** The classifier's own pt-BR explanation, quoted verbatim. */
  readonly workKindReason?: string | null;
  /** Path that already holds a contract, for `contract-exists`. */
  readonly existingContractPath?: string | null;
  /** Locators the pilot tried to bind, for `no-bindable-source`. */
  readonly bindableSources?: readonly string[];
}

function list(values: readonly string[]): string {
  return values.map((value) => `\`${value}\``).join(', ');
}

/**
 * One sentence block per reason: WHAT the pilot decided, WHY, and WHAT the
 * operator can do about it. Portuguese, because this is the operator's channel.
 */
export function describeDesignContractSkip(
  input: DesignContractSkipNarrationInput,
): string {
  const target = `\`${input.targetPath}\``;
  switch (input.reason) {
    case 'no-goal':
      return (
        'Contrato de design: nenhum objetivo de missão chegou ao piloto, então ' +
        'não havia o que classificar e nenhum contrato foi criado. Aprove o ' +
        'contrato de intenção da missão (o objetivo vem dele) e rode ' +
        '`nexus_context_doctor` de novo.'
      );
    case 'not-visual-work':
      return (
        `Contrato de design: o objetivo foi classificado como trabalho de ` +
        `\`${input.workKind ?? 'desconhecido'}\`, não visual, então nenhum ` +
        'contrato de design foi criado — e nenhuma tarefa desta missão vai ' +
        'exigir um. ' +
        (input.workKindReason ? `Classificação: ${input.workKindReason} ` : '') +
        'Se esta missão for mesmo de UI, reescreva o objetivo nomeando a ' +
        'superfície visual (ex.: "redesenhar a tela de …").'
      );
    case 'low-confidence':
      return (
        'Contrato de design: o objetivo parece visual, mas com confiança ' +
        'BAIXA, então o piloto não criou contrato — e, pelo mesmo critério, ' +
        'nenhuma tarefa desta missão vai bloquear com `design_contract_missing`. ' +
        'As duas pontas usam a mesma régua de propósito: nada é exigido do ' +
        'executor que o piloto não tenha criado. ' +
        (input.workKindReason ? `Classificação: ${input.workKindReason} ` : '') +
        'Para obter um contrato, reescreva o objetivo com um sinal visual ' +
        'forte (ex.: "redesign", "design system", "tema", "tipografia", ' +
        '"contraste") ou escreva/importe o contrato à mão em ' +
        `${target}.`
      );
    case 'asset-not-interface':
      return (
        'Contrato de design: o objetivo é trabalho visual de ASSET (sprite, ' +
        'avatar, mascote, ilustração), não de interface. Um asset não tem tela ' +
        'estática para um contrato de tokens governar nem para o revisor ' +
        'fotografar, então nenhum contrato foi criado e nenhuma tarefa vai ' +
        'exigir um. ' +
        (input.workKindReason ? `Classificação: ${input.workKindReason} ` : '') +
        'Se a missão também mexe na interface que exibe o asset, diga isso no ' +
        'objetivo (ex.: "…e a tela que exibe o mascote").'
      );
    case 'contract-exists':
      return (
        'Contrato de design: o projeto já tem contrato vigente em ' +
        `\`${input.existingContractPath ?? input.targetPath}\` e o Nexus nunca ` +
        'sobrescreve autoridade existente, então nenhum rascunho foi criado. ' +
        'Se esse documento estiver desatualizado, edite-o (ou proponha um ' +
        'draft de contexto para ele) — o piloto não vai substituí-lo sozinho.'
      );
    case 'no-bindable-source':
      return (
        'Contrato de design: nenhum arquivo do workspace pôde ser vinculado ' +
        'como evidência' +
        (input.bindableSources && input.bindableSources.length > 0
          ? ` (${list(input.bindableSources)})`
          : '') +
        ', e um contrato sem fonte vinculada não é um rascunho honesto. Numa ' +
        'pasta vazia isso é esperado: este ramo roda ANTES de as propostas ' +
        'estruturais desta mesma passada serem aplicadas, então ele só se ' +
        'recupera na PRÓXIMA passada — deixe o bootstrap materializar o brief ' +
        'do projeto (em missão greenfield é o `PRODUCT.md` aprovado) e rode ' +
        '`nexus_context_doctor` outra vez.'
      );
    case 'foreign-active-draft':
      return (
        `Contrato de design: outro autor já tem rascunho ativo para ${target} ` +
        '(bytes diferentes ou outra missão), então o piloto saiu da frente em ' +
        'vez de disputar o alvo. Revise/aprove ou rejeite aquele rascunho no ' +
        'painel de drafts de contexto; na passada seguinte o piloto volta a agir.'
      );
  }
}

/**
 * The draft exists and is waiting for the mechanical re-derivation of this
 * pass. Not an error state — just the honest middle.
 */
export function describeDesignContractProposed(targetPath: string): string {
  return (
    `Contrato de design proposto em \`${targetPath}\`, aguardando a revisão ` +
    'mecânica desta passada (re-derivação determinística, sem CLI).'
  );
}

/**
 * A genuine non-reproducibility: the re-derivation ran and disagreed. Names the
 * recovery path out loud, because a rejection with no named exit is how a
 * target becomes permanently blocked (A1).
 */
export function describeDesignContractRejected(targetPath: string): string {
  return (
    `Contrato de design: o rascunho de ${`\`${targetPath}\``} foi REJEITADO pela ` +
    'política determinística — a re-derivação do contrato para este escopo e ' +
    'objetivo não bateu byte a byte com o que estava proposto (algo mudou ' +
    'entre propor e revisar: apareceu um contrato, os tokens do projeto ou o ' +
    'catálogo mudaram, ou o rascunho foi editado). Nenhuma autoridade foi ' +
    'escrita. Rode `nexus_context_doctor` de novo: este alvo é ISENTO da ' +
    'memória de rejeição por bytes idênticos, porque seu revisor é uma ' +
    're-derivação determinística e não uma opinião — o piloto re-deriva e ' +
    're-propõe do zero.'
  );
}

/**
 * The re-derivation could not run at all (a transient workspace read failure).
 * Deliberately NOT a rejection: an unreadable file is not proof that a document
 * is irreproducible, and turning it into a durable rejection is what used to
 * block a target forever (A1).
 */
export function describeDesignContractReviewDeferred(
  targetPath: string,
  error: string | null,
): string {
  return (
    `Contrato de design: o rascunho de \`${targetPath}\` continua PROPOSTO — a ` +
    're-derivação independente não pôde ser concluída nesta passada' +
    (error ? ` (${error})` : '') +
    '. Falha de leitura não é prova de que o documento seja irreprodutível, ' +
    'então nada foi rejeitado nem aplicado. Rode `nexus_context_doctor` outra ' +
    'vez; a mesma revisão mecânica decide na próxima passada.'
  );
}
