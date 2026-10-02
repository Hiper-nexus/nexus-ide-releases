import { DIAGNOSTICS_RETENTION_MS } from './constants.js';
import type { BugCategory, BugImpact, BugPlatform } from './constants.js';
import { reportFingerprint } from './fingerprint.js';
import type { CreateReportInput } from './schemas.js';
import { scrubDiagnostics } from './scrub.js';

/** Relato pronto para gravar: tudo já validado e limpo. */
export interface NewBugReport {
  readonly id: string;
  readonly accountId: string;
  readonly title: string;
  readonly description: string;
  readonly steps: string | null;
  readonly category: BugCategory;
  readonly impact: BugImpact;
  readonly appVersion: string;
  readonly platform: BugPlatform;
  readonly arch: string;
  readonly osVersion: string | null;
  readonly adapter: string | null;
  readonly model: string | null;
  readonly paneCount: number | null;
  readonly missionActive: 0 | 1 | null;
  readonly diagnosticsJson: string | null;
  readonly fingerprint: string;
  readonly createdAt: number;
  readonly diagnosticsExpiresAt: number;
}

const orNull = (value: string | undefined): string | null => (value === undefined || value === '' ? null : value);

/**
 * Passa o corpo validado para o formato de gravação. O diagnóstico só entra com consentimento explícito
 * (consent.diagnostics === true); sem ele é descartado em silêncio, mesmo que o cliente o tenha mandado. Com
 * consentimento, é limpo aqui (segredos, caminhos, e-mails) antes de ir para o banco.
 */
export async function buildNewReport(input: CreateReportInput, accountId: string, now: number): Promise<NewBugReport> {
  const diagnostics = input.consent.diagnostics && input.diagnostics !== undefined ? scrubDiagnostics(input.diagnostics) : null;
  return {
    id: crypto.randomUUID(),
    accountId,
    title: input.title,
    description: input.description,
    steps: orNull(input.steps),
    category: input.category,
    impact: input.impact,
    appVersion: input.app.version,
    platform: input.app.platform,
    arch: input.app.arch,
    osVersion: orNull(input.app.osVersion),
    adapter: orNull(input.context?.adapter),
    model: orNull(input.context?.model),
    paneCount: input.context?.paneCount ?? null,
    missionActive: input.context?.missionActive === undefined ? null : input.context.missionActive ? 1 : 0,
    diagnosticsJson: diagnostics === null ? null : JSON.stringify(diagnostics),
    fingerprint: await reportFingerprint({ title: input.title, category: input.category, appVersion: input.app.version }),
    createdAt: now,
    diagnosticsExpiresAt: now + DIAGNOSTICS_RETENTION_MS,
  };
}
