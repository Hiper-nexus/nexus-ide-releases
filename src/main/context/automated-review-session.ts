import { randomUUID } from 'node:crypto';
import type { MissionRisk } from './contract-compiler';
import {
  ReviewCouncil,
  type ReviewBinding,
  type ReviewFindingInput,
  type ReviewGateResult,
  type ReviewReport,
} from './review-council';

export interface AutomatedReviewAuthor {
  readonly id: string;
  readonly sessionId: string;
  readonly provider: string;
}

export interface OpenAutomatedReviewInput {
  readonly missionId: string;
  readonly checkoutPath: string;
  readonly risk: MissionRisk;
  readonly binding: ReviewBinding;
  readonly author: AutomatedReviewAuthor;
  readonly additionalAuthors?: readonly AutomatedReviewAuthor[];
  readonly persist: (report: ReviewReport) => void;
}

export interface AutomatedReviewerIdentity {
  readonly id: string;
  readonly sessionId: string;
  readonly provider: string;
  readonly missionId: string;
  readonly checkoutPath: string;
}

export interface AutomatedReviewResult {
  readonly ready: boolean;
  readonly gate: ReviewGateResult;
  readonly reports: readonly ReviewReport[];
  readonly evidenceIds: readonly string[];
}

interface ReviewSession {
  readonly id: string;
  readonly input: OpenAutomatedReviewInput;
  readonly council: ReviewCouncil;
  readonly waiters: Set<(result: AutomatedReviewResult) => void>;
  result: AutomatedReviewResult | null;
}

function resultFor(session: ReviewSession): AutomatedReviewResult | null {
  const reports = session.council.listReports();
  const hasBlockingFinding = reports.some((report) =>
    report.findings.some((finding) =>
      finding.status === 'open' &&
      (finding.severity === 'critical' || finding.severity === 'high'),
    ),
  );
  const gate = session.council.evaluate();
  if (!hasBlockingFinding && !gate.ready) return null;
  return Object.freeze({
    ready: gate.ready && !hasBlockingFinding,
    gate,
    reports,
    evidenceIds: Object.freeze(reports.map((report) => `review:${report.reviewId}`)),
  });
}

export class AutomatedReviewSessionRegistry {
  readonly #sessions = new Map<string, ReviewSession>();

  open(input: OpenAutomatedReviewInput): string {
    const id = randomUUID();
    this.#sessions.set(id, {
      id,
      input,
      council: new ReviewCouncil(input.risk, input.binding),
      waiters: new Set(),
      result: null,
    });
    return id;
  }

  submit(
    sessionId: string,
    reviewer: AutomatedReviewerIdentity,
    findings: readonly ReviewFindingInput[],
  ): ReviewReport {
    const session = this.#sessions.get(sessionId);
    if (!session) throw new Error('unknown or expired automated review session');
    if (
      reviewer.missionId !== session.input.missionId ||
      reviewer.checkoutPath !== session.input.checkoutPath
    ) {
      throw new Error('reviewer is not bound to this candidate checkout');
    }
    const allAuthors = [
      session.input.author,
      ...(session.input.additionalAuthors ?? []),
    ];
    if (
      allAuthors.some(
        (author) =>
          author.id === reviewer.id || author.sessionId === reviewer.sessionId,
      )
    ) {
      throw new Error('author cannot review their own change or session');
    }
    if (
      (session.input.risk === 'high' || session.input.risk === 'critical') &&
      allAuthors.some((author) => author.provider === reviewer.provider)
    ) {
      throw new Error('high-risk review requires a provider outside every code author');
    }
    const report = session.council.submit({
      reviewId: randomUUID(),
      reviewerId: reviewer.id,
      reviewerSessionId: reviewer.sessionId,
      reviewerProvider: reviewer.provider,
      authorId: session.input.author.id,
      authorSessionId: session.input.author.sessionId,
      authorProvider: session.input.author.provider,
      binding: session.input.binding,
      findings: [...findings],
    });
    session.input.persist(report);
    const result = resultFor(session);
    if (result) {
      session.result = result;
      for (const resolve of session.waiters) resolve(result);
      session.waiters.clear();
    }
    return report;
  }

  wait(sessionId: string, timeoutMs: number): Promise<AutomatedReviewResult> {
    const session = this.#sessions.get(sessionId);
    if (!session) return Promise.reject(new Error('unknown automated review session'));
    if (session.result) return Promise.resolve(session.result);
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30 * 60_000) {
      return Promise.reject(new Error('invalid automated review timeout'));
    }
    return new Promise((resolve, reject) => {
      const settle = (result: AutomatedReviewResult) => {
        clearTimeout(timer);
        session.waiters.delete(settle);
        resolve(result);
      };
      const timer = setTimeout(() => {
        session.waiters.delete(settle);
        reject(new Error('automated review timed out'));
      }, timeoutMs);
      timer.unref();
      session.waiters.add(settle);
    });
  }

  close(sessionId: string): void {
    const session = this.#sessions.get(sessionId);
    if (!session) return;
    this.#sessions.delete(sessionId);
    if (!session.result) {
      const failure = Object.freeze({
        ready: false,
        gate: session.council.evaluate(),
        reports: session.council.listReports(),
        evidenceIds: Object.freeze([]),
      });
      for (const resolve of session.waiters) resolve(failure);
    }
    session.waiters.clear();
  }

  reset(): void {
    for (const id of [...this.#sessions.keys()]) this.close(id);
  }
}

export const automatedReviewSessions = new AutomatedReviewSessionRegistry();
