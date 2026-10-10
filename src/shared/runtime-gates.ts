import { z } from 'zod';
import type { Squad } from './orch-types';
// @ts-expect-error Node 22's direct TypeScript loader requires this extension; app builds use Bundler/noEmit.
import { soakNonce } from './soak-smoke.ts';
export const RUNTIME_GATES_ENV = 'NEXUS_SMOKE_RUNTIME_GATES';
export const RUNTIME_GATEWAY_ENV = 'NEXUS_SMOKE_RUNTIME_GATEWAY';
export const RUNTIME_GATEWAY_NONCE_ENV = 'NEXUS_SMOKE_RUNTIME_GATEWAY_NONCE';
export const RUNTIME_PHASE_ENV = 'NEXUS_SMOKE_RUNTIME_PHASE';
export const RUNTIME_CHANNELS = { run: 'smoke:runtime:run', request: 'smoke:runtime:request', result: 'smoke:runtime:result', stop: 'smoke:runtime:stop' } as const;
export const RUNTIME_DOM_REQUEST = 'nexus:runtime:request';
export const RUNTIME_DOM_REPLY = 'nexus:runtime:reply';
export const RUNTIME_URL_MARKER = 'nexusRuntimeGates';
export const RUNTIME_TIMEOUT_MS = 480000;
export const RUNTIME_REQUIRED = ['ops-runtime', 'standard-workers', 'handoff-ack', 'worker-recovery', 'pane-move',
  'question-answer', 'memory-write', 'voice-capture', 'visual-capture', 'mission-stop'] as const;
export const RUNTIME_RESUME_REQUIRED = ['memory-resume', 'exact-resume', 'mission-stop'] as const;
const id = z.string().min(1).max(256);
/** Explicit, inert operator catalog profile for this finite private fixture. */
export function runtimeStandardProfile(marker: string): Squad {
  return { id: `runtime-profile-${marker}`, name: `Private runtime ${marker}`, createdAt: '1', builtin: false,
    orchestratorInstructions: 'Delegate the finite private report and review to the named helpers. Wait for explicit operator follow-up.', agents: [
      { id: 'rt-standard-chief', agentName: 'Runtime chief', category: 'orchestrator', cli: 'claude', allowedSkills: [],
        allowedTools: ['nexus_pane_spawn', 'nexus_handoff_list', 'nexus_handoff_ack'] },
      { id: 'rt-standard-writer', agentName: 'Runtime writer', category: 'executor', cli: 'claude', allowedSkills: [],
        allowedTools: ['nexus_file_write', 'nexus_preview_start', 'nexus_browser_open', 'nexus_browser_screenshot', 'nexus_handoff_submit'] },
      { id: 'rt-standard-reviewer', agentName: 'Runtime reviewer', category: 'reviewer', cli: 'claude', allowedSkills: [],
        allowedTools: ['nexus_file_read', 'nexus_handoff_submit'] },
    ] };
}
export const runtimeRequestSchema = z.discriminatedUnion('operation', [
  z.object({ nonce: soakNonce, operation: z.literal('created-mission'), sourceSquadId: id, runtimeSquadId: id, creatorPaneId: id, creatorSessionId: id }).strict(),
  z.object({ nonce: soakNonce, operation: z.literal('observe'), missionId: id }).strict(),
  z.object({ nonce: soakNonce, operation: z.literal('session'), sessionId: id }).strict(),
  z.object({ nonce: soakNonce, operation: z.literal('terminate'), sessionId: id }).strict(),
  z.object({ nonce: soakNonce, operation: z.literal('voice-arm') }).strict(),
  z.object({ nonce: soakNonce, operation: z.literal('voice-start') }).strict(),
  z.object({ nonce: soakNonce, operation: z.literal('voice-off') }).strict(),
  z.object({ nonce: soakNonce, operation: z.literal('capture-observation'),
    tracks: z.array(z.object({ id: id, kind: z.literal('audio'), state: z.enum(['live', 'ended']) }).strict()).min(1).max(16),
    contexts: z.array(z.object({ id: soakNonce, state: z.enum(['running', 'suspended', 'closed']) }).strict()).min(1).max(16),
    frames: z.number().int().min(1).max(100000) }).strict(),
  z.object({ nonce: soakNonce, operation: z.literal('question-visible'), missionId: id, questionId: id, frames: z.literal(2), visible: z.literal(true) }).strict(),
  z.object({ nonce: soakNonce, operation: z.literal('move-visible'), sessionId: id, paneId: id, frames: z.literal(2), moved: z.literal(true), echoVisible: z.literal(true) }).strict(),
]);
export type RuntimeRequest = z.infer<typeof runtimeRequestSchema>;
export function parseRuntimeRequest(raw: unknown): RuntimeRequest | null { const result = runtimeRequestSchema.safeParse(raw); return result.success ? result.data : null; }
export function assertRuntimeProof(raw: unknown, phase: 'exercise' | 'resume'): void {
  const value = z.object({ nonce: soakNonce, pid: z.number().int().positive(), phase: z.literal(phase), packaged: z.literal(true),
    appVersion: z.string().regex(/^\d+\.\d+\.\d+$/), checks: z.record(z.string(), z.boolean()),
    cli: z.object({ adapterId: z.literal('claude'), version: id, binarySha256: z.string().regex(/^[a-f0-9]{64}$/), actualInstalled: z.literal(true) }),
    voice: z.object({ grant: z.string(), tracks: z.number().int().nonnegative(), ended: z.number().int().nonnegative(),
      contexts: z.number().int().nonnegative(), closed: z.number().int().nonnegative(), frames: z.number().int().nonnegative() }).optional(),
  }).passthrough().parse(raw);
  const required = phase === 'exercise' ? RUNTIME_REQUIRED : RUNTIME_RESUME_REQUIRED;
  if (Object.keys(value.checks).length !== required.length || required.some(key => value.checks[key] !== true)) throw new Error('runtime gates incomplete');
  if (phase === 'exercise' && (!value.voice || value.voice.grant !== 'granted' || value.voice.tracks < 1 ||
    value.voice.ended !== value.voice.tracks || value.voice.contexts < 1 || value.voice.closed !== value.voice.contexts || value.voice.frames < 1)) throw new Error('real microphone teardown unproved');
}
