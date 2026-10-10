import type { NexusApi } from '../shared/types';
import { RUNTIME_CHANNELS, RUNTIME_DOM_REQUEST, RUNTIME_DOM_REPLY } from '../shared/runtime-gates';
import { soakNonce } from '../shared/soak-smoke';
import { runFunctionalSmokeProbes } from './functional-smoke';
import { sameRuntimeConversation } from '../shared/runtime-gate-proof';
interface Ipc { on(channel: string, listener: (event: unknown, value: any) => void): unknown; removeListener(channel: string, listener: (event: unknown, value: any) => void): unknown; send(channel: string, value: unknown): void; invoke(channel: string, value: unknown): Promise<any> }
export function installRuntimeGatePreload(ipc: Ipc, api: NexusApi, processInfo: { isMainFrame?: boolean }): void {
  if (processInfo.isMainFrame !== true) return;
  let started = false;
  ipc.on(RUNTIME_CHANNELS.run, (_event, input) => {
    if (started || !input || !soakNonce.safeParse(input.nonce).success || !soakNonce.safeParse(input.gatewayNonce).success || !['exercise', 'resume'].includes(input.phase) ||
      typeof input.workspacePath !== 'string' || !input.workspacePath.startsWith('/') || input.workspacePath.length > 4096) return;
    started = true;
    const controller = new AbortController(), nonce = input.nonce, marker = input.gatewayNonce;
    const check = () => { if (controller.signal.aborted) throw new Error('private runtime cancelled'); };
    const request = (operation: string, fields: object = {}) => { check(); return ipc.invoke(RUNTIME_CHANNELS.request, { nonce, operation, ...fields }); };
    let sequence = 0, pending: { request: number; resolve(v: any): void; reject(e: Error): void } | null = null;
    const reply = (event: Event) => {
      const value = (event as CustomEvent).detail;
      if (!pending || value?.nonce !== nonce || value.request !== pending.request) return;
      const old = pending; pending = null; if (value.ok === true) old.resolve(value.result); else old.reject(new Error('private runtime UI failed'));
    };
    const ui = (operation: string, fields: object = {}) => new Promise<any>((resolve, reject) => {
      check(); if (pending) { reject(new Error('overlapping runtime UI')); return; }
      pending = { request: sequence++, resolve, reject }; window.dispatchEvent(new CustomEvent(RUNTIME_DOM_REQUEST, { detail: { nonce, request: pending.request, operation, ...fields } }));
    });
    const stop = (_event: unknown, value: any) => { if (value?.nonce === nonce) { controller.abort(); const old = pending; pending = null; old?.reject(new Error('private runtime stopped')); } };
    window.addEventListener(RUNTIME_DOM_REPLY, reply); ipc.on(RUNTIME_CHANNELS.stop, stop);
    const poll = async (run: () => Promise<any>, accepts: (v: any) => boolean, label: string, timeout = 45000): Promise<any> => {
      const start = performance.now();
      while (performance.now() - start < timeout) { check(); const value = await run(); check(); if (accepts(value)) return value; await new Promise(resolve => setTimeout(resolve, 200)); }
      throw new Error(`runtime observed blocker: ${label}`);
    };
    const observe = (missionId: string) => request('observe', { missionId });
    const direct = async (missionId: string, text: string, targetAgentId: string | null = null) => { check(); await api.mission.command({ kind: 'direct', missionId, targetAgentId, text }); check(); };
    const agentFor = async (missionId: string, expected: any): Promise<string> => {
      if (!expected?.paneId || !expected.sessionId || !expected.bindingSha256 || expected.pid <= 0) throw new Error('private worker binding unavailable');
      const joined = await poll(() => observe(missionId), v => {
        if (v.missionId !== missionId || v.snapshot.id !== missionId) return false;
        const physical = v.agents.filter((a: any) => a.role === 'worker' && a.agentName === expected.agentName);
        if (physical.length > 1) throw new Error('private named worker identity is ambiguous');
        const live = physical[0];
        if (!live || live.paneId !== expected.paneId || live.sessionId !== expected.sessionId || live.pid !== expected.pid ||
          live.adapterId !== expected.adapterId || live.readOnly !== expected.readOnly || live.bindingSha256 !== expected.bindingSha256 ||
          expected.conversation && !sameRuntimeConversation(live.conversation, expected.conversation)) return false;
        const canonical = v.snapshot.agents.filter((a: any) => a.paneId === live.paneId);
        if (canonical.length > 1) throw new Error('private canonical worker identity is ambiguous');
        const agent = canonical[0];
        return agent?.agentName === live.agentName && agent.cli === live.adapterId && agent.terminalLive === true &&
          agent.category === (live.agentName === 'Runtime reviewer' ? 'reviewer' : 'executor') && typeof agent.id === 'string' && agent.id.length > 0;
      }, `current canonical ${expected.agentName}`);
      return joined.snapshot.agents.find((a: any) => a.paneId === expected.paneId).id;
    };
    const prepare = async (lane: 'ops' | 'standard') => {
      const tools = ['nexus_pane_spawn', 'nexus_handoff_submit', 'nexus_handoff_list', 'nexus_handoff_ack', 'nexus_clarify', 'nexus_mission_set_status', 'nexus_terminal_run', 'nexus_file_read', 'nexus_file_write', 'nexus_preview_start', 'nexus_browser_open', 'nexus_browser_screenshot'];
      const review = await api.mission.prepare({ title: `Runtime ${lane} ${marker}`, objective: lane === 'ops' ?
        'Perform a finite operational echo in this private workspace without delegating or editing code.' : 'Write runtime-report.txt and review the private runtime UI and report using at most two workers.',
        contextPaths: [], advanced: { lane }, roster: [
          { id: `rt-${lane}-chief`, agentName: 'Runtime chief', category: 'orchestrator', cli: 'claude', allowedTools: tools, allowedSkills: [] },
          { id: `rt-${lane}-writer`, agentName: 'Runtime writer', category: 'executor', cli: 'claude', allowedTools: tools, allowedSkills: [] },
          { id: `rt-${lane}-reviewer`, agentName: 'Runtime reviewer', category: 'reviewer', cli: 'claude', allowedTools: tools, allowedSkills: [] },
        ] }); check();
      await api.mission.start({ missionId: review.missionId, reviewSha256: review.reviewSha256 }); check();
      await poll(() => observe(review.missionId), v => v.agents.some((a: any) => a.role === 'orchestrator' && a.pid > 0), `${lane} leader`);
      return review.missionId;
    };
    const shutdownMission = async (missionId: string) => {
      await api.mission.command({ kind: 'stop', missionId }); check();
      return poll(() => observe(missionId), v => v.agents.length === 0, 'mission physical stop');
    };
    const flow = async () => {
      const checks: Record<string, boolean> = {};
      let state: any = input.prior, voice: any;
      if (input.phase === 'exercise') {
        const opsId = await prepare('ops');
        await direct(opsId, `RT_GATE OPS ${marker}`);
        await poll(() => observe(opsId), v => v.agents.filter((a: any) => a.role === 'worker').length === 0 && v.audit.some((a: any) => a.tool === 'nexus_terminal_run' && a.result === 'ok'), 'ops execution without workers');
        checks['ops-runtime'] = true;
        await direct(opsId, `RT_GATE QUESTION ${marker}`);
        const questioned = await poll(() => observe(opsId), v => !!v.snapshot.question, 'registered question');
        const question = questioned.snapshot.question;
        const shown = await ui('question', { missionId: opsId, marker: `RT_QUESTION_${marker}` });
        if (!shown.visible) throw new Error('question not actually visible');
        await request('question-visible', { missionId: opsId, questionId: question.id, frames: 2, visible: shown.visible });
        try { await api.mission.command({ kind: 'retry-kickoff', missionId: opsId }); } catch { /* Expected refusal; persisted question is decisive. */ }
        if ((await observe(opsId)).snapshot.question?.id !== question.id) throw new Error('retry erased unanswered question');
        await api.mission.command({ kind: 'answer-question', missionId: opsId, questionId: question.id, optionId: question.options[0].id });
        await poll(() => observe(opsId), v => !v.snapshot.question, 'question answer'); checks['question-answer'] = true;
        await shutdownMission(opsId);
        const standardId = await prepare('standard');
        let observed = await observe(standardId);
        if (!observed.agents.some((a: any) => a.role === 'worker')) await direct(standardId, `RT_GATE SPAWN ${marker}`);
        observed = await poll(() => observe(standardId), v => v.agents.some((a: any) => a.role === 'worker' && a.agentName === 'Runtime writer'), 'actual standard writer');
        const workers = observed.agents.filter((a: any) => a.role === 'worker');
        if (workers.length > 2 || workers.some((a: any) => a.adapterId !== 'claude' || !a.pid)) throw new Error('worker inventory invalid'); checks['standard-workers'] = true;
        const writer = workers.find((a: any) => a.agentName === 'Runtime writer');
        await direct(standardId, `RT_GATE IDLE ${marker}`, await agentFor(standardId, writer));
        observed = await poll(() => observe(standardId), v => v.agents.some((a: any) => a.paneId === writer.paneId && a.conversation), 'native conversation recorded');
        const original = observed.agents.find((a: any) => a.paneId === writer.paneId);
        await request('terminate', { sessionId: original.sessionId });
        await direct(standardId, `RT_GATE RECOVER ${marker} ${original.paneId} ${original.sessionId}`);
        observed = await poll(() => observe(standardId), v => v.recovery?.fromPaneId === original.paneId && v.recovery.fromSessionId === original.sessionId &&
          v.agents.some((a: any) => a.paneId === v.recovery.paneId && a.sessionId === v.recovery.sessionId && a.pid > 0), 'worker recovery');
        const recovered = observed.agents.find((a: any) => a.paneId === observed.recovery.paneId && a.sessionId === observed.recovery.sessionId);
        if (!sameRuntimeConversation(recovered.conversation, original.conversation)) throw new Error('worker recovery lost exact conversation'); checks['worker-recovery'] = true;
        await direct(standardId, `RT_GATE WRITE ${marker}`, await agentFor(standardId, recovered));
        await poll(() => observe(standardId), v => v.handoffs.some((h: any) => h.sessionId === recovered.sessionId && h.status === 'success' && h.summary.includes(`RT_WRITE_${marker}`)), 'actual writer handoff');
        observed = await poll(() => observe(standardId), v => {
          const candidates = v.agents.filter((a: any) => a.role === 'worker' && a.agentName === 'Runtime reviewer');
          if (candidates.length > 1) throw new Error('private Runtime reviewer identity is ambiguous');
          return candidates.length === 1 && candidates[0].pid > 0;
        }, 'actual named reviewer');
        const reviewer = observed.agents.find((a: any) => a.role === 'worker' && a.agentName === 'Runtime reviewer');
        await direct(standardId, `RT_GATE REVIEW ${marker}`, await agentFor(standardId, reviewer));
        await poll(() => observe(standardId), v => v.handoffs.some((h: any) => h.sessionId === reviewer.sessionId && h.status === 'success' && h.summary.includes(`RT_REVIEW_${marker}`)), 'actual reviewer handoff');
        await direct(standardId, `RT_GATE ACK ${marker}`);
        observed = await poll(() => observe(standardId), v => v.audit.some((a: any) => a.tool === 'nexus_handoff_ack' && a.result === 'ok' && a.source === 'http-mcp'), 'physical Maestro ACK'); checks['handoff-ack'] = true;
        await poll(() => observe(standardId), v => v.agents.some((a: any) => a.visual?.assignmentId && a.visual.artifactId), 'Main visual assignment capture'); checks['visual-capture'] = true;
        const memory = await api.memory.attest({ type: 'architecture-rule', title: 'Private runtime fixture', summary: `RT_MEMORY_${marker}`, scope: 'workspace' }); check();
        if (!memory.enabled) throw new Error('workspace memory disabled');
        const recalled = await api.memory.recall({ query: `RT_MEMORY_${marker}` });
        if (!recalled.enabled || !recalled.hits.some(h => h.id === memory.id)) throw new Error('actual memory recall missing'); checks['memory-write'] = true;
        const shell = await ui('shell'), secondShell = await ui('shell'), before = await request('session', { sessionId: shell.sessionId });
        const moved = await ui('move', { paneId: shell.paneId }), after = await request('session', { sessionId: shell.sessionId });
        if (moved.sessionId !== shell.sessionId || before.pid !== after.pid) throw new Error('move respawned physical PTY');
        if (!await api.pty.writeConfirmed(shell.sessionId, `printf 'RT_MOVE_%s\\n' '${marker}'\r`)) throw new Error('moved PTY refuses input');
        await poll(() => request('session', { sessionId: shell.sessionId }), v => v.pid === before.pid && v.echoed, 'moved PTY actual output');
        const view = await poll(() => ui('move-view', { paneId: shell.paneId, marker: `RT_MOVE_${marker}` }), v => v.echoVisible, 'moved PTY actually rendered output');
        await request('move-visible', { sessionId: shell.sessionId, paneId: shell.paneId, ...view }); checks['pane-move'] = true;
        await request('terminate', { sessionId: shell.sessionId });
        await ui('close', { paneId: shell.paneId });
        await request('terminate', { sessionId: secondShell.sessionId }); await ui('close', { paneId: secondShell.paneId });
        const chief = observed.agents.find((a: any) => a.role === 'orchestrator');
        if (typeof chief?.model !== 'string' || !chief.model) throw new Error('normal catalog-resolved native model unavailable');
        await shutdownMission(standardId);
        const operator = await ui('operator-pane', { model: chief.model });
        const adopted = await api.orch.createPaneMission({ paneId: operator.paneId, title: `Runtime native ${marker}`, ownGroup: true }); check();
        if (!adopted.ok || !adopted.mission || adopted.mission.squadId || adopted.mission.intentContract?.workspaceBinding?.adoptedPaneId !== operator.paneId) throw new Error('normal native mission adoption refused');
        const continuityMissionId = adopted.mission.id;
        await direct(continuityMissionId, `RT_GATE IDLE ${marker}`);
        const native = await poll(() => observe(continuityMissionId), v => v.agents.length === 1 && v.agents[0].role === 'orchestrator' &&
          v.agents[0].paneId === operator.paneId && v.agents[0].sessionId === operator.sessionId && v.agents[0].pid > 0 && v.agents[0].conversation && v.agents[0].bindingSha256, 'actual adopted native leader');
        const nativeChief = native.agents[0];
        state = { opsId, standardId, continuityMissionId, chiefPaneId: nativeChief.paneId, chiefSessionId: nativeChief.sessionId, chiefPid: nativeChief.pid,
          bindingSha256: nativeChief.bindingSha256, conversation: nativeChief.conversation, memoryId: memory.id, marker };
        await shutdownMission(continuityMissionId); checks['mission-stop'] = true;
        await ui('media-observe'); const grant = await request('voice-arm');
        await api.voice.setConfig({ jarvisLiveEnabled: true, jarvisLiveTransport: 'classic', wakeWordEnabled: false, speakMode: 'off' });
        await poll(() => api.voice.getInfo(), v => v.captureAllowed === true, 'voice lease info');
        await request('voice-start'); const activeMedia = await poll(() => ui('media-state'), v => v.tracks.some((t: any) => t.kind === 'audio' && t.state === 'live') && v.contexts.length > 0 && v.frames > 0, 'real microphone frames', 10000);
        await request('capture-observation', activeMedia);
        await ui('power-off'); await api.voice.liveHardTeardown(); await request('voice-off');
        voice = await poll(() => ui('media-state'), v => v.tracks.length > 0 && v.tracks.every((t: any) => t.state === 'ended') && v.contexts.length > 0 && v.contexts.every((c: any) => c.state === 'closed'), 'actual microphone/context teardown', 10000);
        await request('capture-observation', voice); voice.grant = grant.grant; await ui('media-cleanup'); checks['voice-capture'] = true;
      } else {
        if (!state?.continuityMissionId || state.continuityMissionId === state.standardId || state.marker !== marker) throw new Error('resume state missing');
        const recalled = await api.memory.recall({ query: `RT_MEMORY_${marker}` });
        if (!recalled.enabled || !recalled.hits.some(h => h.id === state.memoryId)) throw new Error('memory lost across process restart'); checks['memory-resume'] = true;
        const returned = await api.mission.command({ kind: 'resume', missionId: state.continuityMissionId });
        const returnedLeaders = returned.agents.filter(a => a.category === 'orchestrator' && a.terminalLive === true && a.paneId);
        if (returned.id !== state.continuityMissionId || returnedLeaders.length !== 1 || returnedLeaders[0].paneId === state.chiefPaneId) throw new Error('normal resumed leader identity invalid');
        const restored = await poll(() => observe(state.continuityMissionId), v => v.agents.length === 1 && v.agents[0].role === 'orchestrator' &&
          v.agents[0].paneId === returnedLeaders[0].paneId && v.agents[0].pid > 0, 'single returned resumed leader');
        const chief = restored.agents.find((a: any) => a.role === 'orchestrator');
        if (chief.sessionId === state.chiefSessionId || chief.pid === state.chiefPid || chief.bindingSha256 !== state.bindingSha256 ||
          !sameRuntimeConversation(chief.conversation, state.conversation)) throw new Error('resume replaced exact conversation or runtime');
        await direct(state.continuityMissionId, `RT_GATE RESUME ${marker}`);
        await poll(() => observe(state.continuityMissionId), v => v.resumedOutput.includes(chief.sessionId), 'actual CLI resumed history reply'); checks['exact-resume'] = true;
        await shutdownMission(state.continuityMissionId); checks['mission-stop'] = true;
      }
      const finalFunctional = await runFunctionalSmokeProbes(api, input.workspacePath); check();
      if (!finalFunctional.ok) throw new Error('runtime repeated functional probes failed');
      ipc.send(RUNTIME_CHANNELS.result, { nonce, phase: input.phase, checks, voice, state, finalFunctional });
    };
    void flow().catch(error => ipc.send(RUNTIME_CHANNELS.result, { nonce, failed: String(error.message).slice(0, 256) })).finally(() => {
      window.removeEventListener(RUNTIME_DOM_REPLY, reply); ipc.removeListener(RUNTIME_CHANNELS.stop, stop);
    });
  });
}
