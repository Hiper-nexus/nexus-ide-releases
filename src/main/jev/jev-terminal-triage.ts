/**
 * Triagem de falha de comando via TypeSafe Jev (piloto automático,
 * superfície `terminalTriage`). Um `exitCode !== 0` no nexus_terminal_run
 * ganha UMA chamada `judge()` que classifica a falha e diz se um rerun puro
 * ajudaria — o agente decide o que fazer com isso. Fail-open: null = sem
 * campo `triage` na resposta, exatamente como hoje.
 */
import {
  capText,
  judge,
  USD_PER_INPUT_TOKEN,
  type JevQuestion,
} from './jev-client';
import { isJevSurfaceEnabled } from './jev-autopilot';
import { hasJevCredential } from './jev-secrets';
import {
  jevAnswerConfidences,
  jevAnswerProbabilities,
  recordJevDecision,
} from './jev-decision-log';

const TRIAGE_TIMEOUT_MS = 6_000;

export const COMMAND_TRIAGE_KINDS = [
  'flaky',
  'environment',
  'config',
  'regression',
  'usage',
] as const;

export type CommandTriageKind = (typeof COMMAND_TRIAGE_KINDS)[number];

export interface CommandTriage {
  kind: CommandTriageKind;
  confidence: number;
  retryHelps: number;
  model: string;
}

const TRIAGE_QUESTIONS: Record<string, JevQuestion> = {
  kind: {
    type: 'choice',
    instructions:
      'Classify the root cause of this command failure into exactly one kind.',
    criteria: {
      flaky:
        'transient failure likely to pass on a plain rerun (network hiccup, timing, port busy)',
      environment:
        'the machine/environment: missing tool, permissions, disk, memory, wrong Node/Python version',
      config:
        'project or tool misconfiguration: wrong flags, missing env var, bad config file',
      regression: 'a real defect in the code under test or being built',
      usage:
        'the command itself was wrong: typo, wrong path, bad arguments',
    },
  },
  retry_helps: {
    type: 'noul',
    instructions:
      'Would simply running the same command again likely succeed without ' +
      'any change?',
    criteria: {
      true: 'a plain rerun would likely succeed',
      false: 'a rerun would fail the same way',
    },
  },
};

export interface TriageCommandFailureDeps {
  judge?: typeof judge;
  enabled?: () => boolean;
  hasKey?: () => boolean;
  /** Abort externo (autoridade MCP) combinado ao timeout interno. */
  signal?: AbortSignal;
}

export async function triageCommandFailure(
  input: { command: string; exitCode: number; output: string },
  deps: TriageCommandFailureDeps = {},
): Promise<CommandTriage | null> {
  const judgeFn = deps.judge ?? judge;
  const enabled = deps.enabled ?? (() => isJevSurfaceEnabled('terminalTriage'));
  const hasKey = deps.hasKey ?? hasJevCredential;

  if (!enabled() || !hasKey()) return null;
  if (input.exitCode === 0 || !input.output.trim()) return null;

  const result = await judgeFn({
    state: {
      command: capText(input.command, 500),
      exitCode: input.exitCode,
      output: capText(input.output, 6_000, { keepTail: true }),
    },
    questions: TRIAGE_QUESTIONS,
    timeoutMs: TRIAGE_TIMEOUT_MS,
    signal: deps.signal,
    surface: 'terminalTriage',
  });
  if (!result) return null;

  const kindAnswer = result.answers.kind;
  if (kindAnswer?.type !== 'choice') return null;
  const kind = COMMAND_TRIAGE_KINDS.includes(
    kindAnswer.choice as CommandTriageKind,
  )
    ? (kindAnswer.choice as CommandTriageKind)
    : 'regression';
  const retryAnswer = result.answers.retry_helps;

  recordJevDecision({
    surface: 'terminalTriage',
    model: result.model,
    questions: Object.keys(TRIAGE_QUESTIONS),
    probabilities: jevAnswerProbabilities(result.answers),
    confidence: jevAnswerConfidences(result.answers),
    decision: `triage:${kind}`,
    inputTokens: result.usage.input_tokens,
    usd: result.usage.input_tokens * USD_PER_INPUT_TOKEN,
  });

  return {
    kind,
    confidence: kindAnswer.confidence,
    retryHelps: retryAnswer?.type === 'noul' ? retryAnswer.noul : 0,
    model: result.model,
  };
}
