import { randomUUID } from 'node:crypto';
import type { ProjectExecutionScope } from '../../shared/types';
import type { MissionRisk } from './contract-compiler';
import {
  ReviewCouncil,
  type ReviewBinding,
  type ReviewFindingInput,
  type ReviewGateResult,
  type ReviewReport,
} from './review-council';
import { isAutomatedReviewerAgentName } from '../orch/prevc-reviewer-profile';

const AUTHORITY_POLL_MS = 50;

export interface AutomatedReviewAuthor {
  readonly id: string;
  readonly sessionId: string;
  readonly provider: string;
}

export interface OpenAutomatedReviewInput {
  readonly missionId: string;
  readonly checkoutPath: string;
  readonly requiresDesignInspection?: boolean;
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

export interface AutomatedReviewDesignSurface {
  readonly paneId: string;
  readonly previewId: string;
  readonly url: string;
  readonly missionId: string;
  readonly scope: Readonly<ProjectExecutionScope>;
  readonly executionScope: Readonly<ProjectExecutionScope>;
}

export type AutomatedReviewDesignInspection =
  | 'open'
  | 'read'
  | 'inspect'
  | 'screenshot'
  | 'wait';

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error(
        typeof signal.reason === 'string'
          ? signal.reason
          : 'session_authority_revoked',
      );
}

interface ReviewSession {
  readonly id: string;
  readonly input: OpenAutomatedReviewInput;
  readonly council: ReviewCouncil;
  readonly waiters: Set<(result: AutomatedReviewResult) => void>;
  designSurface: AutomatedReviewDesignSurface | null;
  readonly designInspectionsByReviewer: Map<
    string,
    Set<AutomatedReviewDesignInspection>
  >;
  result: AutomatedReviewResult | null;
}

function sameScope(
  left: Readonly<ProjectExecutionScope>,
  right: Readonly<ProjectExecutionScope>,
): boolean {
  return (
    left.version === right.version &&
    left.installationId === right.installationId &&
    left.projectId === right.projectId &&
    left.checkoutId === right.checkoutId &&
    left.rootRealPath === right.rootRealPath &&
    left.identitySource === right.identitySource
  );
}

function freezeSurface(
  surface: AutomatedReviewDesignSurface,
): AutomatedReviewDesignSurface {
  return Object.freeze({
    ...surface,
    scope: Object.freeze({ ...surface.scope }),
    executionScope: Object.freeze({ ...surface.executionScope }),
  });
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
      designSurface: null,
      designInspectionsByReviewer: new Map(),
      result: null,
    });
    return id;
  }

  bindDesignSurface(
    sessionId: string,
    surface: AutomatedReviewDesignSurface,
  ): AutomatedReviewDesignSurface {
    const session = this.#sessions.get(sessionId);
    if (!session) throw new Error('unknown or expired automated review session');
    if (!session.input.requiresDesignInspection) {
      throw new Error('automated review session has no design inspection contract');
    }
    if (
      surface.missionId !== session.input.missionId ||
      surface.missionId !== session.input.binding.missionId ||
      surface.scope.projectId !== session.input.binding.projectId ||
      surface.scope.checkoutId !== session.input.binding.checkoutId ||
      surface.executionScope.projectId !== surface.scope.projectId ||
      surface.executionScope.checkoutId !== surface.scope.checkoutId ||
      surface.executionScope.installationId !== surface.scope.installationId ||
      surface.executionScope.rootRealPath !== session.input.checkoutPath ||
      !surface.paneId.trim() ||
      !surface.previewId.trim()
    ) {
      throw new Error(
        'design review surface is not bound to the exact mission checkout',
      );
    }
    if (session.designSurface) {
      throw new Error('design review surface is already bound');
    }
    session.designSurface = freezeSurface(surface);
    return session.designSurface;
  }

  findActiveDesignSurface(input: {
    readonly reviewSessionId: string;
    readonly paneId?: string;
    readonly missionId: string;
    readonly scope: Readonly<ProjectExecutionScope>;
    readonly executionScope: Readonly<ProjectExecutionScope>;
  }): AutomatedReviewDesignSurface | null {
    const session = this.#sessions.get(input.reviewSessionId);
    const surface = session?.designSurface;
    if (
      !session ||
      !session.input.requiresDesignInspection ||
      !surface ||
      surface.missionId !== input.missionId ||
      (input.paneId !== undefined && surface.paneId !== input.paneId) ||
      !sameScope(surface.scope, input.scope) ||
      !sameScope(surface.executionScope, input.executionScope)
    ) {
      return null;
    }
    return surface;
  }

  recordDesignInspection(
    sessionId: string,
    reviewerSessionId: string,
    paneId: string,
    inspection: AutomatedReviewDesignInspection,
  ): void {
    const session = this.#sessions.get(sessionId);
    if (!session) throw new Error('unknown or expired automated review session');
    if (
      !session.input.requiresDesignInspection ||
      !session.designSurface ||
      session.designSurface.paneId !== paneId
    ) {
      throw new Error('browser pane is not bound to this design review');
    }
    if (!reviewerSessionId.trim()) {
      throw new Error('design inspection requires a physical reviewer session');
    }
    const inspections =
      session.designInspectionsByReviewer.get(reviewerSessionId) ?? new Set();
    inspections.add(inspection);
    session.designInspectionsByReviewer.set(reviewerSessionId, inspections);
  }

  /**
   * Prove that a pane profile was issued for one currently active review
   * session. This is consulted only by the main-process MCP bearer boundary;
   * the opaque session id remains unavailable to renderer-supplied authority.
   */
  findActiveReviewerSessionId(input: {
    readonly missionId: string;
    readonly checkoutPath: string;
    readonly providerId: string;
    readonly agentName: string;
  }): string | null {
    if (
      !isAutomatedReviewerAgentName(input.agentName, input.providerId)
    ) {
      return null;
    }
    for (const session of this.#sessions.values()) {
      if (
        session.input.missionId !== input.missionId ||
        session.input.checkoutPath !== input.checkoutPath
      ) {
        continue;
      }
      const opaquePrefix = session.id.replaceAll('-', '').slice(0, 12);
      if (input.agentName.endsWith(`-${opaquePrefix}`)) return session.id;
    }
    return null;
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
    // Provider labels are evidence metadata, not an independence boundary.
    // Governed reviewers are separate main-owned panes; immutable agent and
    // physical PTY session identities above prevent author aliasing even when
    // Codex is the only release-qualified worker CLI.
    const designInspections =
      session.designInspectionsByReviewer.get(reviewer.sessionId);
    if (
      session.input.requiresDesignInspection &&
      (
        !session.designSurface ||
        !designInspections?.has('read') ||
        !designInspections.has('screenshot')
      )
    ) {
      throw new Error(
        'rendered design review requires this reviewer session to read and screenshot its bound browser pane',
      );
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

  wait(
    sessionId: string,
    timeoutMs: number,
    signal?: AbortSignal,
    assertCurrentAuthority?: () => void,
  ): Promise<AutomatedReviewResult> {
    const session = this.#sessions.get(sessionId);
    if (!session) return Promise.reject(new Error('unknown automated review session'));
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30 * 60_000) {
      return Promise.reject(new Error('invalid automated review timeout'));
    }
    try {
      assertCurrentAuthority?.();
    } catch (error) {
      return Promise.reject(error);
    }
    if (signal?.aborted) return Promise.reject(abortError(signal));
    if (session.result) return Promise.resolve(session.result);
    return new Promise((resolve, reject) => {
      let authorityTimer: NodeJS.Timeout | null = null;
      const cleanup = () => {
        clearTimeout(timer);
        if (authorityTimer) clearInterval(authorityTimer);
        signal?.removeEventListener('abort', onAbort);
        session.waiters.delete(settle);
      };
      const settle = (result: AutomatedReviewResult) => {
        try {
          assertCurrentAuthority?.();
        } catch (error) {
          cleanup();
          reject(error);
          return;
        }
        cleanup();
        resolve(result);
      };
      const onAbort = () => {
        cleanup();
        reject(abortError(signal as AbortSignal));
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error('automated review timed out'));
      }, timeoutMs);
      timer.unref();
      session.waiters.add(settle);
      signal?.addEventListener('abort', onAbort, { once: true });
      if (assertCurrentAuthority) {
        authorityTimer = setInterval(() => {
          try {
            assertCurrentAuthority();
          } catch (error) {
            cleanup();
            reject(error);
          }
        }, AUTHORITY_POLL_MS);
        authorityTimer.unref();
      }
      if (signal?.aborted) onAbort();
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
