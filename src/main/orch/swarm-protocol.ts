import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

export const MAX_OWNED_FILES_PER_WORKER = 40;
export const MAX_REVIEW_CYCLES = 2;

const FILLER_PATTERNS = [
  /^(?:thanks|thank you)(?:\s+(?:a lot|very much))?(?:\s+for\b[^.!*]*)?[!.]*$/im,
  /^(?:great (?:job|work)|well done|awesome|perfect)(?:\s+everyone)?[!.]*$/im,
  /^(?:sure thing|no problem|you're welcome|glad to help)[!.]*$/im,
  /^(?:understood|got it|acknowledged|roger that)[!.]*$/im,
  /^(?:hello|hi(?: there)?|hey(?: there)?)[!.]*$/im,
  /^(?:obrigad[oa]|de nada|valeu|entendido|combinado)(?:\s+a todos)?[!.]*$/im,
];

/**
 * Anti-social chatter filter: Swarm agents communicate solely with structured
 * facts, file diffs, and machine-actionable summaries. Strips conversational
 * fluff that pollutes context windows and burns LLM tokens.
 */
export function filterAntiSocialChatter(rawText: string): {
  clean: string;
  strippedCount: number;
} {
  const lines = rawText.split(/\r?\n/);
  const cleanLines: string[] = [];
  let strippedCount = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    let isFiller = false;
    for (const pattern of FILLER_PATTERNS) {
      if (pattern.test(trimmed)) {
        isFiller = true;
        strippedCount++;
        break;
      }
    }
    if (!isFiller) {
      cleanLines.push(line);
    }
  }

  return {
    clean: cleanLines.join('\n').trim(),
    strippedCount,
  };
}

export interface ScopeEnforcementResult {
  readonly allowed: boolean;
  readonly violations: readonly string[];
  readonly totalModified: number;
}

/**
 * Enforces scope-freeze and owned files boundaries.
 * Prevents scope creep and cross-contamination across swarm workers.
 */
export function enforceScopeRules(options: {
  ownedFiles: readonly string[];
  modifiedFiles: readonly string[];
  maxFiles?: number;
}): ScopeEnforcementResult {
  const max = options.maxFiles ?? MAX_OWNED_FILES_PER_WORKER;
  const ownedSet = new Set(options.ownedFiles.map((f) => path.normalize(f)));
  const violations: string[] = [];

  for (const file of options.modifiedFiles) {
    const normalized = path.normalize(file);
    if (!ownedSet.has(normalized)) {
      violations.push(normalized);
    }
  }

  const exceedsLimit = options.modifiedFiles.length > max;
  const allowed = violations.length === 0 && !exceedsLimit;

  return {
    allowed,
    violations,
    totalModified: options.modifiedFiles.length,
  };
}

export interface ReviewCycleCheck {
  readonly canProceed: boolean;
  readonly escalateToOperator: boolean;
  readonly currentCycle: number;
}

/**
 * Enforce max review cycles (default 2) before human operator intervention.
 * Prevents endless ping-pong loops between reviewer and implementer agents.
 */
export function checkReviewCycleLimit(
  cycleCount: number,
  maxCycles = MAX_REVIEW_CYCLES,
): ReviewCycleCheck {
  if (cycleCount >= maxCycles) {
    return {
      canProceed: false,
      escalateToOperator: true,
      currentCycle: cycleCount,
    };
  }
  return {
    canProceed: true,
    escalateToOperator: false,
    currentCycle: cycleCount,
  };
}

export const swarmMailboxMessageSchema = z
  .object({
    sender: z.string().min(1).max(128),
    recipient: z.string().min(1).max(128),
    messageId: z.string().min(1).max(128).optional(),
    content: z.string().max(65536),
    payload: z.record(z.string(), z.unknown()).optional(),
    timestamp: z.number().int().nonnegative().optional(),
  })
  .strict();

export type SwarmMailboxMessage = z.infer<typeof swarmMailboxMessageSchema>;

export interface SwarmMailboxWriteOptions {
  baseDir: string;
  message: SwarmMailboxMessage;
  nudgeRecipient?: boolean;
}

export interface SwarmMailboxWriteResult {
  transcriptPath: string;
  inboxPath: string;
  nudgePath?: string;
}

/**
 * Atomically writes a swarm message with transcript-first ordering:
 * 1. transcript/<ts>-<id>.json written FIRST (immutable global history)
 * 2. inbox/<recipient>/<ts>-<id>.json written SECOND
 * 3. Optional inbox/<recipient>/.nudge touched to wake recipient
 */
export function writeSwarmMailboxMessage(
  options: SwarmMailboxWriteOptions,
): SwarmMailboxWriteResult {
  const msg = swarmMailboxMessageSchema.parse(options.message);
  const ts = msg.timestamp ?? Date.now();
  const id = msg.messageId ?? randomUUID();

  const transcriptDir = path.join(options.baseDir, 'transcript');
  const safeRecipient =
    msg.recipient.replace(/[^a-zA-Z0-9_-]/g, '') || 'default';
  const recipientInboxDir = path.join(options.baseDir, 'inbox', safeRecipient);

  fs.mkdirSync(transcriptDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(recipientInboxDir, { recursive: true, mode: 0o700 });

  const record = {
    ...msg,
    messageId: id,
    timestamp: ts,
  };
  const serialized = JSON.stringify(record, null, 2);

  // 1. Write transcript FIRST (atomic via temp + rename)
  const transcriptFinal = path.join(transcriptDir, `${ts}-${id}.json`);
  const transcriptTmp = path.join(
    transcriptDir,
    `.${ts}-${id}.${randomUUID()}.tmp`,
  );
  fs.writeFileSync(transcriptTmp, serialized, {
    mode: 0o600,
    encoding: 'utf8',
  });
  fs.renameSync(transcriptTmp, transcriptFinal);

  // 2. Write recipient inbox SECOND (atomic via temp + rename)
  const inboxFinal = path.join(recipientInboxDir, `${ts}-${id}.json`);
  const inboxTmp = path.join(
    recipientInboxDir,
    `.${ts}-${id}.${randomUUID()}.tmp`,
  );
  fs.writeFileSync(inboxTmp, serialized, {
    mode: 0o600,
    encoding: 'utf8',
  });
  fs.renameSync(inboxTmp, inboxFinal);

  // 3. Optional nudge
  let nudgePath: string | undefined;
  if (options.nudgeRecipient) {
    nudgePath = path.join(recipientInboxDir, '.nudge');
    fs.writeFileSync(nudgePath, String(ts), {
      mode: 0o600,
      encoding: 'utf8',
    });
  }

  return {
    transcriptPath: transcriptFinal,
    inboxPath: inboxFinal,
    nudgePath,
  };
}
