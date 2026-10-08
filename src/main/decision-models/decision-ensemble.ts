import type { DecisionProvider } from '../../shared/decision-models';
import type { JevAnswer } from '../jev/jev-client';
import type { JevDecisionSurface } from '../jev/jev-decision-log';
import { SECURITY_ENSEMBLE_SURFACES } from './decision-routing';

/** Mesma folga da soma de probabilidade do Jev. Abaixo disto os modelos concordam. */
const AGREEMENT = 0.02;

/**
 * Nestas perguntas, probabilidade menor é o veredito mais restritivo
 * (menos coerência, menos evidência). Nas demais, maior é mais restritivo
 * (injeção, efeito destrutivo, pendência admitida).
 */
const LOWER_IS_RESTRICTIVE = new Set([
  'coherent',
  'is_specific',
  'has_verification',
  'names_changes',
  'changed_code',
]);

export interface EnsembleMember {
  provider: DecisionProvider;
  answers: Record<string, JevAnswer>;
}

export type EnsembleCombine =
  | {
    ok: true;
    answers: Record<string, JevAnswer>;
    diverged: boolean;
    /** Números por pergunta e provedor. Sem texto da consulta. */
    peers: Record<string, Record<string, number>>;
  }
  | { ok: false; reason: 'divergent' };

function withinAgreement(values: number[]): boolean {
  const gap = Math.max(...values) - Math.min(...values);
  return gap <= AGREEMENT + 1e-9;
}

function noulConfidence(value: number): number {
  return Math.abs(value - 0.5);
}

function answerNumber(answer: JevAnswer): number {
  return answer.type === 'noul' ? answer.noul : answer.confidence;
}

function restrictiveNoul(name: string, values: number[]): number {
  return LOWER_IS_RESTRICTIVE.has(name) ? Math.min(...values) : Math.max(...values);
}

function mostConfidentIndex(scores: number[]): number {
  let best = 0;
  for (let index = 1; index < scores.length; index += 1) {
    if (scores[index] > scores[best]) best = index;
  }
  return best;
}

/**
 * Concordância segue, com a confiança maior. Na segurança, o número nunca
 * fica mais frouxo que o conjunto (com o Jev na jogada, Luna e Clef só
 * apertam). Fora dela, a divergência fica com a confiança maior. Escolha
 * sem ordem restritiva, na segurança, não elege vencedor.
 */
export function combineEnsembleAnswers(
  members: readonly EnsembleMember[],
  surface?: string,
): EnsembleCombine {
  if (members.length < 2) return { ok: false, reason: 'divergent' };
  const security = Boolean(surface && SECURITY_ENSEMBLE_SURFACES.has(surface as JevDecisionSurface));
  const names = new Set<string>();
  for (const member of members) {
    for (const name of Object.keys(member.answers)) names.add(name);
  }
  const merged: Record<string, JevAnswer> = {};
  const peers: Record<string, Record<string, number>> = {};
  let diverged = false;
  for (const name of names) {
    const group = members.map(member => member.answers[name]);
    if (group.some(answer => !answer)) return { ok: false, reason: 'divergent' };
    const answers = group as JevAnswer[];
    if (new Set(answers.map(answer => answer.type)).size !== 1) return { ok: false, reason: 'divergent' };
    peers[name] = {};
    members.forEach((member, index) => { peers[name][member.provider] = answerNumber(answers[index]); });
    const first = answers[0];
    if (first.type === 'noul') {
      const values = answers.map(answer => answer.type === 'noul' ? answer.noul : Number.NaN);
      const agreed = withinAgreement(values);
      if (security) {
        if (!agreed) diverged = true;
        merged[name] = { type: 'noul', noul: restrictiveNoul(name, values) };
      } else {
        const picked = values[mostConfidentIndex(values.map(noulConfidence))];
        if (!agreed) diverged = true;
        merged[name] = { type: 'noul', noul: picked };
      }
    } else if (first.type === 'choice') {
      const choices = new Set(answers.map(answer => answer.type === 'choice' ? answer.choice : ''));
      if (choices.size !== 1) {
        if (security) return { ok: false, reason: 'divergent' };
        diverged = true;
        const confidences = answers.map(answer => answer.type === 'choice' ? answer.confidence : 0);
        merged[name] = answers[mostConfidentIndex(confidences)];
      } else {
        const confidences = answers.map(answer => answer.type === 'choice' ? answer.confidence : 0);
        merged[name] = answers[mostConfidentIndex(confidences)];
      }
    } else {
      const scores = answers.map(answer => answer.type === 'score' ? answer.score : Number.NaN);
      const confidences = answers.map(answer => answer.type === 'score' ? answer.confidence : 0);
      const agreed = withinAgreement(scores);
      if (security) {
        if (!agreed) diverged = true;
        const tight = Math.min(...scores);
        const donor = answers.find(answer => answer.type === 'score' && answer.score === tight) ?? first;
        merged[name] = donor.type === 'score' ? { ...donor, score: tight } : first;
      } else {
        if (!agreed) diverged = true;
        merged[name] = answers[mostConfidentIndex(confidences)];
      }
    }
  }
  return { ok: true, answers: merged, diverged, peers };
}
