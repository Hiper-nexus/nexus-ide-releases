import { createHash } from 'node:crypto';
import { z } from 'zod';

/** BridgeBench-inspired immutable contract for future live Nexus eval runs. */
export const NEXUS_BENCHMARK_METHODOLOGY = 'nexus-bench-v1';

const subjectSchema = z
  .object({
    id: z.string().min(1).max(160),
    adapterId: z.string().min(1).max(80),
    modelId: z.string().min(1).max(160),
  })
  .strict();

const caseSchema = z
  .object({
    id: z.string().min(1).max(160),
    dimension: z.enum(['coding', 'reasoning', 'frontend', 'security']),
    revision: z.string().min(1).max(80),
    publicHash: z.string().regex(/^[a-f0-9]{64}$/),
    privateHash: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  })
  .strict();

export const benchmarkRunManifestSchema = z
  .object({
    version: z.literal(1),
    methodology: z.literal(NEXUS_BENCHMARK_METHODOLOGY),
    suiteId: z.string().min(1).max(80),
    suiteRevision: z.string().min(1).max(80),
    seed: z.string().min(1).max(160),
    promptPolicyHash: z.string().regex(/^[a-f0-9]{64}$/),
    subjects: z.array(subjectSchema).min(2).max(128),
    cases: z.array(caseSchema).min(1).max(10_000),
  })
  .strict()
  .superRefine((manifest, context) => {
    if (new Set(manifest.subjects.map((subject) => subject.id)).size !== manifest.subjects.length) {
      context.addIssue({ code: 'custom', path: ['subjects'], message: 'subjects must be unique' });
    }
    if (new Set(manifest.cases.map((item) => item.id)).size !== manifest.cases.length) {
      context.addIssue({ code: 'custom', path: ['cases'], message: 'cases must be unique' });
    }
  });

export type BenchmarkRunManifest = z.infer<typeof benchmarkRunManifestSchema>;

const benchmarkJournalEntrySchema = z
  .object({
    version: z.literal(1),
    runId: z.string().regex(/^bench-[a-f0-9]{20}$/),
    manifestHash: z.string().regex(/^[a-f0-9]{64}$/),
    sequence: z.number().int().positive(),
    matchId: z.string().min(1).max(160),
    caseId: z.string().min(1).max(160),
    subjectA: z.string().min(1).max(160),
    subjectB: z.string().min(1).max(160),
    outcome: z.enum(['judged', 'forfeit', 'no-contest']),
    winnerId: z.string().min(1).max(160).nullable(),
    evidenceHash: z.string().regex(/^[a-f0-9]{64}$/),
    timestamp: z.string().datetime(),
  })
  .strict();

export type BenchmarkJournalEntry = z.infer<typeof benchmarkJournalEntrySchema>;

export interface VerifiedBenchmarkJournal {
  runId: string;
  manifestHash: string;
  entries: BenchmarkJournalEntry[];
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalize(child)]),
  );
}

export function canonicalBenchmarkJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function benchmarkManifestHash(manifest: BenchmarkRunManifest): string {
  return createHash('sha256')
    .update(canonicalBenchmarkJson(manifest))
    .digest('hex');
}

export function benchmarkRunId(manifest: BenchmarkRunManifest): string {
  return `bench-${benchmarkManifestHash(manifest).slice(0, 20)}`;
}

export function evidenceHash(value: unknown): string {
  return createHash('sha256').update(canonicalBenchmarkJson(value)).digest('hex');
}

export function verifyBenchmarkJournal(
  rawEntries: readonly unknown[],
  rawManifest: unknown,
): VerifiedBenchmarkJournal {
  const manifest = benchmarkRunManifestSchema.parse(rawManifest);
  const manifestHash = benchmarkManifestHash(manifest);
  const runId = benchmarkRunId(manifest);
  const subjects = new Set(manifest.subjects.map((subject) => subject.id));
  const cases = new Set(manifest.cases.map((item) => item.id));
  const seenMatches = new Set<string>();
  const entries: BenchmarkJournalEntry[] = [];
  let previousSequence = 0;

  for (const [index, raw] of rawEntries.entries()) {
    const entry = benchmarkJournalEntrySchema.parse(raw);
    if (entry.runId !== runId) throw new Error(`journal entry ${index + 1} has the wrong runId`);
    if (entry.manifestHash !== manifestHash) {
      throw new Error(`journal entry ${index + 1} has a different manifest hash`);
    }
    if (entry.sequence <= previousSequence) {
      throw new Error(`journal sequence must increase at entry ${index + 1}`);
    }
    if (seenMatches.has(entry.matchId)) throw new Error(`duplicate matchId: ${entry.matchId}`);
    if (!cases.has(entry.caseId)) throw new Error(`unknown benchmark case: ${entry.caseId}`);
    if (!subjects.has(entry.subjectA) || !subjects.has(entry.subjectB)) {
      throw new Error(`journal entry ${index + 1} references an unknown subject`);
    }
    if (entry.subjectA === entry.subjectB) throw new Error(`journal entry ${index + 1} matches a subject against itself`);
    if (entry.winnerId && entry.winnerId !== entry.subjectA && entry.winnerId !== entry.subjectB) {
      throw new Error(`journal entry ${index + 1} has an invalid winner`);
    }
    if (entry.outcome === 'no-contest' && entry.winnerId !== null) {
      throw new Error(`no-contest entry ${index + 1} cannot have a winner`);
    }
    seenMatches.add(entry.matchId);
    previousSequence = entry.sequence;
    entries.push(entry);
  }

  return { runId, manifestHash, entries };
}
