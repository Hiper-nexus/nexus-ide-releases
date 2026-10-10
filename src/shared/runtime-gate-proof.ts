import { z } from 'zod';
// @ts-expect-error Node 22's direct TypeScript loader requires this extension; app builds use Bundler/noEmit.
import { RUNTIME_REQUIRED, RUNTIME_RESUME_REQUIRED } from './runtime-gates.ts';
const conversation = z.object({ key: z.enum(['session_id', 'conversation_id']), id: z.string().min(1) }).passthrough();
const agent = z.object({ paneId: z.string(), sessionId: z.string(), role: z.string(), adapterId: z.string(), pid: z.number().int().positive().nullable(),
  conversation: conversation.nullable(), bindingSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  visual: z.object({ assignmentId: z.string(), artifactId: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).optional() }).passthrough();
const recovery = z.object({ fromPaneId: z.string(), fromSessionId: z.string(), paneId: z.string(), sessionId: z.string(),
  chiefSessionId: z.string(), invocationId: z.string() });
const observation = z.object({ missionId: z.string(), lane: z.string().optional(), agents: z.array(agent), snapshot: z.object({
  question: z.object({ id: z.string() }).passthrough().optional() }).passthrough(), handoffs: z.array(z.object({ id: z.string(), status: z.string(), summary: z.string(),
    deliveryState: z.string(), consumedBySession: z.string().optional(), consumedDeliveryAttemptId: z.string().optional() }).passthrough()),
  acknowledgements: z.array(z.object({ handoffId: z.string(), sessionId: z.string(), deliveryAttemptId: z.string(), invocationId: z.string(), source: z.literal('http-mcp') })),
  recovery: recovery.optional(),
  audit: z.array(z.object({ tool: z.string(), result: z.string(), source: z.string(), session: z.string(), invocation: z.string().optional(), handoffId: z.string().optional(), resume: z.string().optional() })) }).passthrough();
export function sameRuntimeConversation(a: unknown, b: unknown): boolean {
  const left = conversation.safeParse(a), right = conversation.safeParse(b);
  return left.success && right.success && left.data.key === right.data.key && left.data.id === right.data.id;
}
/** Recomputed from Main's own observations, never from renderer checks:true. */
export function deriveRuntimeChecks(input: {
  phase: 'exercise' | 'resume'; history: readonly unknown[]; terminated: readonly string[]; memoryIds: readonly string[];
  marker: string; state: { standardId: string; chiefPaneId: string; conversation: unknown; memoryId: string };
  resumedOutput: readonly string[]; echoSessions: readonly string[]; visibleQuestions: readonly string[]; visibleMoves: readonly string[];
  questionCommands: readonly { missionId: string; questionId: string; kind: 'retry-kickoff' | 'answer-question'; refused: boolean; remainingQuestionId?: string }[];
  voice?: { permissions: number; started: boolean; released: boolean; live: { tracks: number; live: number; frames: number; trackIds: string[]; contextIds: string[] } | null;
    final: { tracks: number; ended: number; contexts: number; closed: number; frames: number; trackIds: string[]; contextIds: string[] } | null };
}): Record<string, boolean> {
  const missions = input.history.flatMap(raw => { const parsed = observation.safeParse(raw); return parsed.success ? [parsed.data] : []; });
  const standard = missions.filter(v => v.missionId === input.state.standardId && v.lane === 'standard');
  const chiefs = standard.flatMap(v => v.agents.filter(a => a.role === 'orchestrator'));
  const last = standard.at(-1);
  const stopped = !!last && last.agents.length === 0;
  const memory = input.memoryIds.includes(input.state.memoryId);
  if (input.phase === 'resume') {
    const resumed = chiefs.some(a => a.pid && a.paneId === input.state.chiefPaneId && sameRuntimeConversation(a.conversation, input.state.conversation) && input.resumedOutput.includes(a.sessionId));
    const result = { 'memory-resume': memory, 'exact-resume': resumed, 'mission-stop': stopped };
    if (RUNTIME_RESUME_REQUIRED.some(key => !result[key])) throw new Error('Main resume observations incomplete');
    return result;
  }
  const ops = missions.filter(v => v.lane === 'ops');
  const opsRun = ops.some(v => v.agents.some(a => a.role === 'orchestrator' && a.pid) && v.audit.some(a => a.tool === 'nexus_terminal_run' && a.result === 'ok' && a.source === 'http-mcp')) &&
    ops.every(v => !v.agents.some(a => a.role === 'worker')) && ops.at(-1)?.agents.length === 0;
  const questionIndex = ops.findIndex(v => !!v.snapshot.question);
  const question = ops[questionIndex]?.snapshot.question;
  const answered = !!question && input.visibleQuestions.includes(question.id) && input.questionCommands.some(c => c.missionId === ops[questionIndex]!.missionId &&
    c.questionId === question.id && c.kind === 'retry-kickoff' && c.refused && c.remainingQuestionId === question.id) &&
    input.questionCommands.some(c => c.missionId === ops[questionIndex]!.missionId && c.questionId === question.id && c.kind === 'answer-question' && !c.refused && !c.remainingQuestionId) &&
    ops.slice(questionIndex + 1).some(v => !v.snapshot.question);
  const workers = standard.flatMap(v => v.agents.filter(a => a.role === 'worker'));
  const workerInventory = workers.some(a => a.pid && a.adapterId === 'claude') && standard.every(v => v.agents.filter(a => a.role === 'worker').length <= 2 &&
    v.agents.every(a => a.adapterId === 'claude' && (a.pid === null || a.pid > 0)));
  const recovered = standard.some((value, index) => {
    const relation = value.recovery;
    if (!relation) return false;
    const before = standard.slice(0, index).flatMap(v => v.agents).find(a => a.role === 'worker' && a.paneId === relation.fromPaneId && a.sessionId === relation.fromSessionId && a.pid && a.conversation);
    if (!before?.bindingSha256 || !input.terminated.includes(before.sessionId)) return false;
    const candidates = value.agents.filter(a => a.role === 'worker' && a.bindingSha256 === before.bindingSha256 && sameRuntimeConversation(a.conversation, before.conversation));
    const after = candidates[0];
    return candidates.length === 1 && after?.paneId === relation.paneId && after.paneId !== before.paneId && after.sessionId === relation.sessionId && after.sessionId !== before.sessionId &&
      !!after.pid && after.pid !== before.pid && value.agents.some(a => a.role === 'orchestrator' && a.sessionId === relation.chiefSessionId && a.pid) &&
      value.audit.some(a => a.tool === 'nexus_pane_spawn' && a.result === 'ok' && a.source === 'http-mcp' && a.session === relation.chiefSessionId &&
        a.invocation === relation.invocationId && a.resume === relation.fromPaneId);
  });
  const handoff = standard.some(v => v.handoffs.some(h => h.status === 'success' && h.summary.includes(input.marker) && h.deliveryState === 'consumed' &&
    v.acknowledgements.some(r => r.handoffId === h.id && r.sessionId === h.consumedBySession && r.deliveryAttemptId === h.consumedDeliveryAttemptId &&
      chiefs.some(c => c.sessionId === r.sessionId) && v.audit.some(a => a.tool === 'nexus_handoff_ack' && a.result === 'ok' && a.source === 'http-mcp' &&
        a.session === r.sessionId && a.handoffId === h.id && a.invocation === r.invocationId))));
  const visual = workers.some(a => !!a.visual?.assignmentId && !!a.visual.artifactId);
  const sessions = input.history.flatMap(raw => { const parsed = z.object({ sessionId: z.string(), pid: z.number().int().positive() }).safeParse(raw); return parsed.success ? [parsed.data] : []; });
  const moved = sessions.some((a, i) => input.terminated.includes(a.sessionId) && input.echoSessions.includes(a.sessionId) && input.visibleMoves.includes(a.sessionId) && sessions.slice(i + 1).some(b => b.sessionId === a.sessionId && b.pid === a.pid));
  const voice = input.voice;
  const captured = !!voice && voice.permissions > 0 && voice.started && voice.released && !!voice.live && !!voice.final &&
    voice.live.live > 0 && voice.live.frames > 0 && voice.final.tracks === voice.live.tracks && voice.final.tracks > 0 &&
    voice.final.ended === voice.final.tracks && voice.final.contexts > 0 && voice.final.closed === voice.final.contexts && voice.final.frames >= voice.live.frames &&
    voice.live.trackIds.length === voice.live.tracks && voice.final.trackIds.length === voice.final.tracks &&
    voice.live.trackIds.every(id => voice.final!.trackIds.includes(id)) && voice.live.contextIds.every(id => voice.final!.contextIds.includes(id));
  const result = { 'ops-runtime': !!opsRun, 'standard-workers': workerInventory, 'handoff-ack': handoff, 'worker-recovery': recovered,
    'pane-move': moved, 'question-answer': answered, 'memory-write': memory, 'voice-capture': captured, 'visual-capture': visual, 'mission-stop': stopped };
  if (RUNTIME_REQUIRED.some(key => !result[key])) throw new Error(`Main runtime observations incomplete: ${RUNTIME_REQUIRED.filter(key => !result[key]).join(', ')}`);
  return result;
}
