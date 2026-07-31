/**
 * Delegação frictionless da aprovação de missão para a revisão de plano
 * verificada do wizard de produto.
 *
 * Quando o wizard submete um objetivo que ele mesmo exibirá na revisão de
 * plano in-app (MissionWizardPlanReview), main registra um grant in-memory
 * ligado a sender + missão + intentVersion, single-use e com TTL. O clique em
 * "Enviar para aprovação" dessa revisão vale como a aprovação: o approve
 * consome o grant e recebe o `approvalReviewSha256` do review integral —
 * sem o segundo modal nativo para o mesmo intent.
 *
 * O grant NUNCA é emitido no gate E2E real (a causalidade exige exatamente um
 * diálogo nativo), e o consume não dispensa as demais guardas do approve:
 * risco destrutivo, rota experimental e promoção continuam no modal nativo.
 */

import type { WebContents } from "electron";

import { isCurrentProcessRealMissionE2E } from "../../shared/real-mission-e2e";

/** A revisão humana do plano pode levar minutos; o grant não pode ser eterno. */
const GRANT_TTL_MS = 30 * 60 * 1_000;

interface WizardPlanReviewGrant {
  readonly intentVersion: number;
  readonly expiresAt: number;
}

const grants = new Map<string, WizardPlanReviewGrant>();

function grantKey(ownerId: number, missionId: string): string {
  return `${ownerId}:${missionId}`;
}

function sweepExpired(now: number): void {
  for (const [key, grant] of grants) {
    if (grant.expiresAt <= now) grants.delete(key);
  }
}

/**
 * Emite o grant da submissão que o wizard acabou de compilar e vai exibir na
 * revisão de plano. Re-submissões sobrescrevem (o intentVersion mais novo é o
 * único revisado). No-op no gate E2E real.
 */
export function recordWizardPlanReviewGrant(
  owner: WebContents,
  missionId: string,
  intentVersion: number,
): void {
  if (isCurrentProcessRealMissionE2E()) return;
  const now = Date.now();
  sweepExpired(now);
  grants.set(grantKey(owner.id, missionId), {
    intentVersion,
    expiresAt: now + GRANT_TTL_MS,
  });
}

/**
 * Consome (single-use) o grant se ele existir, estiver vivo e casar com o
 * intentVersion que o approve acabou de revisar. Qualquer divergência
 * invalida o grant — o caller cai no modal nativo.
 */
export function consumeWizardPlanReviewGrant(
  owner: WebContents,
  missionId: string,
  intentVersion: number,
): boolean {
  const key = grantKey(owner.id, missionId);
  const grant = grants.get(key);
  if (!grant) return false;
  grants.delete(key);
  if (grant.expiresAt <= Date.now()) return false;
  return grant.intentVersion === intentVersion;
}

/** Test seam: wipe all grants. */
export function clearWizardPlanReviewGrantsForTests(): void {
  grants.clear();
}
