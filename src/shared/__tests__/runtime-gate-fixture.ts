export function runtimeFactFixture(phase: 'exercise' | 'resume' = 'exercise') {
  const marker = '11111111-1111-4111-8111-111111111111';
  const conversation = { key: 'session_id', id: 'native-real-fixture-id' };
  const chief = { paneId: 'chief', sessionId: 'chief-sid', role: 'orchestrator', adapterId: 'claude', pid: 123, conversation };
  const worker = { paneId: 'writer', sessionId: 'old-worker', role: 'worker', agentName: 'Runtime writer', readOnly: false, adapterId: 'claude', pid: 234, conversation, bindingSha256: 'b'.repeat(64) };
  const observed = (missionId: string, lane: string, agents: unknown[], question?: { id: string }) => ({ missionId, lane, agents,
    snapshot: question ? { question } : {}, handoffs: [], acknowledgements: [], audit: [] } as any);
  const first = observed('ops', 'ops', [chief]); first.audit.push({ tool: 'nexus_terminal_run', result: 'ok', source: 'http-mcp', session: 'chief-sid' });
  const standard = observed('std', 'standard', [chief, worker]);
  const recovered = observed('std', 'standard', [chief, { ...worker, paneId: 'writer-resumed', sessionId: 'new-worker', pid: 345, visual: { assignmentId: 'main-assignment-uuid', artifactId: 'capture', sha256: 'a'.repeat(64) } }]);
  recovered.agents.push({ ...worker, agentName: 'Runtime reviewer', readOnly: true, paneId: 'reviewer', sessionId: 'reviewer-sid', pid: 346, conversation: { key: 'session_id', id: 'reviewer-native' } });
  recovered.recovery = { fromPaneId: 'writer', fromSessionId: 'old-worker', paneId: 'writer-resumed', sessionId: 'new-worker', chiefSessionId: 'chief-sid', invocationId: 'resume-call' };
  recovered.handoffs.push({ id: 'handoff', sessionId: 'new-worker', status: 'success', summary: `RT_WRITE_${marker}`, deliveryState: 'consumed', consumedBySession: 'chief-sid', consumedDeliveryAttemptId: 'delivery' });
  recovered.acknowledgements.push({ handoffId: 'handoff', sessionId: 'chief-sid', deliveryAttemptId: 'delivery', invocationId: 'physical-call', source: 'http-mcp' });
  recovered.audit.push({ tool: 'nexus_handoff_ack', result: 'ok', source: 'http-mcp', session: 'chief-sid', invocation: 'physical-call', handoffId: 'handoff' });
  recovered.audit.push({ tool: 'nexus_pane_spawn', result: 'ok', source: 'http-mcp', session: 'chief-sid', invocation: 'resume-call', resume: 'writer' });
  recovered.handoffs.push({ id: 'review-handoff', sessionId: 'reviewer-sid', status: 'success', summary: `RT_REVIEW_${marker}`, deliveryState: 'consumed', consumedBySession: 'chief-sid', consumedDeliveryAttemptId: 'review-delivery' });
  recovered.acknowledgements.push({ handoffId: 'review-handoff', sessionId: 'chief-sid', deliveryAttemptId: 'review-delivery', invocationId: 'review-ack', source: 'http-mcp' });
  recovered.audit.push({ tool: 'nexus_handoff_ack', result: 'ok', source: 'http-mcp', session: 'chief-sid', invocation: 'review-ack', handoffId: 'review-handoff' });
  return { phase, marker, state: { standardId: 'std', chiefPaneId: 'chief', conversation, memoryId: 'memory', marker },
    history: phase === 'resume' ? [standard, observed('std', 'standard', [])] : [first, observed('ops', 'ops', [chief], { id: 'question' }),
      observed('ops', 'ops', [chief], { id: 'question' }), observed('ops', 'ops', [chief]), observed('ops', 'ops', []), standard, recovered,
      { sessionId: 'shell', pid: 456 }, { sessionId: 'shell', pid: 456 }, observed('std', 'standard', [])],
    terminated: ['old-worker', 'shell'], memoryIds: ['memory'], resumedOutput: phase === 'resume' ? ['chief-sid'] : [], echoSessions: ['shell'], visibleQuestions: ['question'], visibleMoves: ['shell'],
    questionCommands: [{ missionId: 'ops', questionId: 'question', kind: 'retry-kickoff' as const, refused: true, remainingQuestionId: 'question' },
      { missionId: 'ops', questionId: 'question', kind: 'answer-question' as const, refused: false }],
    voice: { permissions: 1, started: true, released: true,
      live: { tracks: 1, live: 1, frames: 2, trackIds: ['actual-track-id'], contextIds: ['actual-context-id'] },
      final: { tracks: 1, ended: 1, contexts: 1, closed: 1, frames: 3, trackIds: ['actual-track-id'], contextIds: ['actual-context-id'] } },
  };
}
