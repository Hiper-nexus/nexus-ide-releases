import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { systemPreferences, type BrowserWindow, type IpcMain } from 'electron';
import { RUNTIME_CHANNELS, RUNTIME_TIMEOUT_MS, parseRuntimeRequest, assertRuntimeProof } from '../shared/runtime-gates';
import { deriveRuntimeChecks, sameRuntimeConversation } from '../shared/runtime-gate-proof';
import { runtimeGateConfiguration, armPrivateRuntimeClaudeConsent } from './runtime-gate-mode';
import { requireLiveRendererWorkspaceScope } from './persistence/renderer-workspace-scope';
import { getProjectDomainStores } from './orch/project-domain-store-registry';
import { missionEngineForScope } from './orch/mission-engine-registry';
import { listAgentSessions, probePaneFootprints, orchTerminateSession, isSessionOwnedBy, getSessionCwd, tapSessionData } from './pty/pty-manager';
import { sameProjectScope } from './orch/project-scoped-broadcast';
import { getProviderPaneSession } from './persistence/provider-session-store';
import { getAdapter, resolveAdapterBinary, isAdapterInstalled } from './adapters/adapter-registry';
import { readAuditLog } from './jarvis/audit-log';
import { armPrivateCaptureProbe, privateCaptureProbeAllowed, privateCaptureMediaPermission } from './voice/private-capture-probe';
import { getWorkspaceMemoryStore } from './memory/workspace-memory';
import { getContextBySession, isCurrentGateContext, executionScopeFor } from './orch/gate';
import { checkVisualHandoff } from './orch/visual-handoff-gate';
import { createScopedBrowserArtifactStore } from './browser/browser-artifact-store';
import { getMissionEventRuntimeManager } from './orch/mission-event-emit';
import { parseFunctionalSmokeResult } from '../shared/smoke-types';
import { armPrivateMissionCommandProbe } from './private-mission-command-probe';
import { VOICE_CHANNELS } from '../shared/voice-channels';
const execute = promisify(execFile);

export async function proveRuntimeGates(win: BrowserWindow, input: { ipc: IpcMain; userData: string; workspacePath: string;
  appVersion: string; smokeTest: boolean; packaged: boolean; signal: AbortSignal; requestPhysicalShutdown(): void }): Promise<void> {
  const config = runtimeGateConfiguration({ ...input, env: process.env });
  if (!config) throw new Error('runtime gates require the explicit private launch');
  const check = (): void => { if (input.signal.aborted) throw new Error('runtime gates cancelled'); };
  check();
  for (const directory of [input.userData, path.join(input.userData, 'home')]) {
    const stat = await fs.lstat(directory); check(); const canonical = await fs.realpath(directory); check();
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.mode & 0o077 || canonical !== directory || stat.uid !== process.getuid?.()) throw new Error('runtime gates profile is not private');
  }
  const hello = await fetch(`${config.gateway}/runtime-hello`, { signal: AbortSignal.any([input.signal, AbortSignal.timeout(5000)]) }).then(r => r.json()); check();
  if (hello.nonce !== config.gatewayNonce || hello.pid !== process.ppid) throw new Error('runtime gateway is not the owned launcher');
  // These values are fixture credentials, generated from the verifier nonce.
  // Existing provider resolution and canonical spawn still decide HOME/grants.
  process.env.ANTHROPIC_API_KEY = `rt-${config.gatewayNonce}`;
  process.env.ANTHROPIC_AUTH_TOKEN = `rt-${config.gatewayNonce}`;
  process.env.ANTHROPIC_BASE_URL = config.gateway;
  process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';
  process.env.CLAUDE_CONFIG_DIR = path.join(input.userData, 'home', '.claude');
  process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR = path.join(input.userData, 'home', '.claude-secure');
  const adapter = getAdapter('claude');
  if (!adapter || adapter.kind !== 'cli-pty' || !isAdapterInstalled('claude')) throw new Error('actual installed Claude CLI unavailable');
  const binary = resolveAdapterBinary('claude');
  if (!binary) throw new Error('actual Claude binary unavailable');
  const canonicalBinary = await fs.realpath(binary); check();
  const bytes = await fs.readFile(canonicalBinary); check();
  const version = (await execute(canonicalBinary, ['--version'], { env: process.env, timeout: 15000, maxBuffer: 65536 })).stdout.trim(); check();
  const cli = { adapterId: 'claude', version: version.slice(0, 128), binarySha256: createHash('sha256').update(bytes).digest('hex'), actualInstalled: true };
  const wc = win.webContents, frame = wc.mainFrame, nonce = randomUUID();
  const scope = requireLiveRendererWorkspaceScope(wc);
  if (scope.rootRealPath !== input.workspacePath) throw new Error('runtime renderer is not the private fixture workspace');
  const stores = getProjectDomainStores(scope);
  const verifiedAgent = (agent: ReturnType<typeof listAgentSessions>[number]): boolean => {
    const ctx = getContextBySession(agent.sessionId);
    return ctx !== null && isCurrentGateContext(ctx) && ctx.sessionId === agent.sessionId &&
      ctx.missionId === agent.missionId && ctx.role === agent.role && sameProjectScope(ctx.scope, scope) &&
      sameProjectScope(agent.scope, executionScopeFor(ctx)) &&
      (!agent.coordinationScope || sameProjectScope(agent.coordinationScope, scope));
  };
  const history: unknown[] = [], terminated = new Set<string>();
  let stopped = false, flight: Promise<unknown> | null = null, releaseVoice: (() => void) | null = null;
  const echoSessions = new Set<string>(), armedShells = new Set<string>(), resumedOutput = new Set<string>(), visibleQuestions = new Set<string>();
  const visibleMoves = new Set<string>();
  const outputWindows = new Map<string, string>(), captures = new Map<string, { path: string; sha256: string; assignmentId: string; artifactId: string }>();
  const voice: Parameters<typeof deriveRuntimeChecks>[0]['voice'] = { permissions: 0, started: false, released: false, live: null, final: null };
  const questionCommands: Parameters<typeof deriveRuntimeChecks>[0]['questionCommands'][number][] = [];
  const statePath = path.join(input.userData, 'runtime-gates-state.json');
  let prior: unknown = null;
  if (config.phase === 'resume') {
    const fd = await fs.open(statePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try { const stat = await fd.stat(); check(); if (!stat.isFile() || stat.nlink !== 1 || stat.size <= 0 || stat.size > 65536) throw new Error('unsafe runtime state');
      const bytes = Buffer.alloc(stat.size); let offset = 0;
      while (offset < bytes.length) { const read = await fd.read(bytes, offset, bytes.length - offset, offset); check(); if (!read.bytesRead) throw new Error('runtime state short read'); offset += read.bytesRead; }
      const after = await fs.lstat(statePath); check();
      if (!after.isFile() || after.dev !== stat.dev || after.ino !== stat.ino || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || await fs.realpath(statePath) !== statePath) throw new Error('runtime state changed');
      check(); prior = JSON.parse(bytes.toString('utf8')); }
    finally { await fd.close(); } check();
  }
  const releaseConsent = armPrivateRuntimeClaudeConsent({ userData: input.userData, gateway: config.gateway,
    gatewayNonce: config.gatewayNonce, scope, signal: input.signal,
    isCurrent: () => !wc.isDestroyed() && wc.mainFrame === frame && !stopped &&
      sameProjectScope(requireLiveRendererWorkspaceScope(wc), scope) });
  try { await new Promise<void>((resolve, reject) => {
    const current = (): void => { check(); if (stopped || wc.mainFrame !== frame || !sameProjectScope(requireLiveRendererWorkspaceScope(wc), scope)) throw new Error('runtime authority revoked'); };
    const captureAgentBinding = (info: ReturnType<typeof listAgentSessions>[number]) => {
      const authority = getContextBySession(info.sessionId);
      const binding = authority && { sessionId: authority.sessionId, missionId: authority.missionId, role: authority.role,
        coordination: { ...authority.scope }, execution: { ...executionScopeFor(authority) } };
      const assertCurrent = (): void => {
        current();
        const live = listAgentSessions().find(v => v.sessionId === info.sessionId);
        if (!live || !authority || !binding || live.sessionId !== info.sessionId || live.paneId !== info.paneId ||
          live.adapterId !== info.adapterId || live.accountId !== info.accountId || live.missionId !== info.missionId ||
          live.role !== info.role || !sameProjectScope(live.scope, info.scope) ||
          !sameProjectScope(live.coordinationScope ?? binding.coordination, info.coordinationScope ?? binding.coordination) ||
          getContextBySession(live.sessionId) !== authority || !verifiedAgent(live) ||
          authority.sessionId !== binding.sessionId || authority.missionId !== binding.missionId || authority.role !== binding.role ||
          !sameProjectScope(authority.scope, binding.coordination) || !sameProjectScope(executionScopeFor(authority), binding.execution)) {
          throw new Error('runtime agent binding changed');
        }
      };
      assertCurrent();
      return { authority, assertCurrent };
    };
    const addHistory = (value: unknown): void => { if (history.length >= 1200) throw new Error('runtime observation budget exceeded'); history.push(value); };
    const revokeVoice = (): void => { releaseVoice?.(); releaseVoice = null;
      // This is a disposable acceptance session. Revocation remains deny-all,
      // including late permission callbacks; no operator session is modified.
      try { wc.session.setPermissionRequestHandler((_sender, _permission, callback) => callback(false));
        wc.session.setPermissionCheckHandler(() => false); } catch { /* The destroyed private session has no remaining renderer. */ } };
    const removeTap = tapSessionData((id, data) => {
      if (stopped || input.signal.aborted) return;
      try { current(); } catch { return; }
      const agent = listAgentSessions().find(a => a.sessionId === id);
      if (agent ? !verifiedAgent(agent) : !(armedShells.has(id) && isSessionOwnedBy(wc, id) && getSessionCwd(id) === input.workspacePath)) return;
      const text = ((outputWindows.get(id) ?? '') + data).slice(-2048); outputWindows.set(id, text);
      if (armedShells.has(id) && text.includes(`RT_MOVE_${config.gatewayNonce}`)) echoSessions.add(id);
      if (text.includes(`RT_RESUME_OK_${config.gatewayNonce}`)) resumedOutput.add(id);
    }, { name: 'private-runtime-acceptance', delivery: 'complete' });
    let commandProbeFailed = false;
    const releaseCommands = armPrivateMissionCommandProbe({ wc, frame, scope, nonce,
      snapshot: async id => { current(); const snapshot = await missionEngineForScope(scope).snapshot(scope, id); current(); return snapshot; },
      record: value => { current(); if (questionCommands.length >= 8) throw new Error('private command observation budget'); questionCommands.push(value); },
      failed: () => { commandProbeFailed = true; } });
    const cleanup = (): void => { clearTimeout(timer); releaseConsent(); revokeVoice(); removeTap(); releaseCommands(); outputWindows.clear(); input.ipc.removeHandler(RUNTIME_CHANNELS.request);
      input.ipc.removeListener(RUNTIME_CHANNELS.result, onResult); input.signal.removeEventListener('abort', onAbort); wc.removeListener('render-process-gone', onGone); win.removeListener('closed', onGone); };
    const fail = (reason = 'runtime proof incomplete'): void => { if (stopped) return; stopped = true; releaseConsent(); revokeVoice();
      console.error(`[smoke] runtime failed: ${reason.replace(/[\r\n]/gu, ' ').slice(0, 256)}`);
      try { wc.send(RUNTIME_CHANNELS.stop, { nonce }); } catch { /* Main owns physical quit. */ }
      input.requestPhysicalShutdown();
      void Promise.resolve(flight).finally(() => { cleanup(); reject(new Error('runtime proof failed; physical shutdown requested')); }).catch(() => undefined);
    };
    const onAbort = (): void => fail(), onGone = (): void => fail();
    input.ipc.handle(RUNTIME_CHANNELS.request, async (event, raw) => {
      if (event.sender !== wc || event.senderFrame !== frame) throw new Error('runtime sender refused'); current();
      const req = parseRuntimeRequest(raw); if (!req || req.nonce !== nonce || flight) throw new Error('runtime request refused');
      const work = (async () => {
        if (req.operation === 'voice-arm') {
          const grant = systemPreferences.getMediaAccessStatus('microphone');
          if (grant !== 'granted') throw new Error(`external microphone permission blocker: ${grant}`);
          releaseVoice = armPrivateCaptureProbe(wc, scope, nonce, grant);
          // Private process only. Late requests stay denied after lease release.
          wc.session.setPermissionRequestHandler((sender, permission, callback, details) => {
            const allowed = privateCaptureMediaPermission(sender, permission, details, 'request', systemPreferences.getMediaAccessStatus('microphone'));
            if (allowed) voice.permissions++; callback(allowed);
          });
          wc.session.setPermissionCheckHandler((sender, permission, _origin, details) => {
            const allowed = privateCaptureMediaPermission(sender, permission, details, 'check', systemPreferences.getMediaAccessStatus('microphone'));
            if (allowed) voice.permissions++; return allowed;
          });
          return { grant };
        }
        if (req.operation === 'voice-start') { if (!privateCaptureProbeAllowed(wc, frame)) throw new Error('voice lease absent'); voice.started = true; wc.send(VOICE_CHANNELS.pttStart); return { started: true }; }
        if (req.operation === 'voice-off') { revokeVoice(); voice.released = true; return { stopped: true }; }
        if (req.operation === 'capture-observation') { if (!voice.started) throw new Error('capture was not started by Main');
          const trackIds = req.tracks.map(t => t.id), contextIds = req.contexts.map(c => c.id);
          if (new Set(trackIds).size !== trackIds.length || new Set(contextIds).size !== contextIds.length) throw new Error('duplicate capture object identity');
          const sample = { tracks: req.tracks.length, live: req.tracks.filter(t => t.state === 'live').length, ended: req.tracks.filter(t => t.state === 'ended').length,
            contexts: req.contexts.length, closed: req.contexts.filter(c => c.state === 'closed').length, frames: req.frames, trackIds, contextIds };
          if (voice.released) voice.final = sample; else { if (!privateCaptureProbeAllowed(wc, frame)) throw new Error('capture lease lost'); voice.live = sample; }
          return { recorded: true };
        }
        if (req.operation === 'question-visible') {
          const snapshot = await missionEngineForScope(scope).snapshot(scope, req.missionId); current();
          if (snapshot.question?.id !== req.questionId) throw new Error('visible question is not the live Main question');
          visibleQuestions.add(req.questionId); return { recorded: true };
        }
        if (req.operation === 'move-visible') {
          if (!armedShells.has(req.sessionId) || !echoSessions.has(req.sessionId) || !isSessionOwnedBy(wc, req.sessionId) || getSessionCwd(req.sessionId) !== input.workspacePath) throw new Error('move does not identify the live private echoed PTY');
          visibleMoves.add(req.sessionId); return { recorded: true };
        }
        if (req.operation === 'observe') {
          const mission = stores.missions.get(req.missionId);
          if (!mission || !mission.title.includes(config.gatewayNonce)) throw new Error('private mission absent');
          const snapshot = await missionEngineForScope(scope).snapshot(scope, req.missionId); current();
          const footprints = await probePaneFootprints(); current();
          const bindings: Array<() => void> = [], stagedCaptures: Array<{ path: string; sha256: string; assignmentId: string; artifactId: string }> = [];
          const agents = await Promise.all(listAgentSessions().filter(v => v.missionId === req.missionId && verifiedAgent(v)).map(async v => {
            const { authority: ctx, assertCurrent } = captureAgentBinding(v); bindings.push(assertCurrent);
            const assignmentId = ctx?.visualTask?.id; let visual;
            if (ctx?.visualTask && assignmentId) {
              const verdict = await checkVisualHandoff(ctx, { assertCurrent }); assertCurrent();
              if (verdict.required && verdict.verified) {
                const manager = getMissionEventRuntimeManager();
                const artifact = manager && await createScopedBrowserArtifactStore(manager, scope).verifiedScreenshot(verdict.artifactId, assertCurrent); assertCurrent();
                if (!artifact || artifact.missionId !== mission.id || artifact.url !== `${config.gateway}/runtime-page`) throw new Error('visual artifact provenance differs');
                visual = { assignmentId, artifactId: artifact.id, sha256: artifact.sha256 };
                stagedCaptures.push({ ...visual, path: artifact.path });
              }
            }
            assertCurrent();
            return {
            paneId: v.paneId, sessionId: v.sessionId, role: v.role, adapterId: v.adapterId, agentName: v.agentName,
            pid: footprints?.find(f => f.sessionId === v.sessionId)?.rootPid ?? null,
            conversation: v.paneId ? getProviderPaneSession(scope, v.paneId, v.adapterId, v.accountId) : null,
            ...(visual ? { visual } : {}),
          }; })); current();
          bindings.forEach(assertCurrent => assertCurrent());
          stagedCaptures.forEach(capture => captures.set(capture.artifactId, capture));
          const result = { missionId: mission.id, lane: mission.intentContract?.lane, status: mission.status, snapshot, agents,
            handoffs: stores.handoffs.list({ missionId: mission.id, includeDelivered: true }),
            acknowledgements: getMissionEventRuntimeManager()?.open(scope).db.prepare(`SELECT handoff_id AS handoffId, orchestrator_session_id AS sessionId,
              delivery_attempt_id AS deliveryAttemptId, tool_call_id AS invocationId, source FROM handoff_ack_receipts WHERE mission_id = ? AND source = 'http-mcp' LIMIT 16`).all(mission.id) ?? [],
            audit: readAuditLog({ scope }, 200).filter(v => v.mission_id === mission.id).map(v => ({ tool: v.tool, result: v.result, source: v.source,
              session: v.session, invocation: v.invocation_id, handoffId: typeof v.args.handoffId === 'string' ? v.args.handoffId : undefined })) };
          // Keep the canonical response for the driver, but persist only the
          // bounded Main facts needed by the gate, not repeated full briefs.
          addHistory({ ...result, snapshot: { question: snapshot.question },
            handoffs: result.handoffs.map(h => ({ id: h.id, status: h.status, summary: h.summary.slice(0, 512), deliveryState: h.deliveryState,
              consumedBySession: h.consumedBySession, consumedDeliveryAttemptId: h.consumedDeliveryAttemptId })),
            audit: result.audit.filter(a => a.result === 'ok' && ['nexus_terminal_run', 'nexus_handoff_ack'].includes(a.tool)) });
          return { ...result, resumedOutput: [...resumedOutput] };
        }
        const info = listAgentSessions().find(v => v.sessionId === req.sessionId);
        const agent = info && verifiedAgent(info);
        const captured = agent ? captureAgentBinding(info) : null;
        const own = !info && isSessionOwnedBy(wc, req.sessionId) && getSessionCwd(req.sessionId) === input.workspacePath;
        if (!own && !agent) throw new Error('foreign runtime session');
        if (req.operation === 'terminate') { const closed = await orchTerminateSession(req.sessionId, { origin: 'private-runtime-gate' }); current(); if (!closed) throw new Error('runtime physical termination unproved'); terminated.add(req.sessionId); return { closed }; }
        const footprints = await probePaneFootprints(); current();
        if (captured) captured.assertCurrent();
        else if (listAgentSessions().some(v => v.sessionId === req.sessionId) || !isSessionOwnedBy(wc, req.sessionId) ||
          getSessionCwd(req.sessionId) !== input.workspacePath) throw new Error('runtime session binding changed during lookup');
        const pid = footprints?.find(v => v.sessionId === req.sessionId)?.rootPid;
        if (!pid) throw new Error('runtime session PID unavailable'); armedShells.add(req.sessionId);
        const result = { sessionId: req.sessionId, pid }; addHistory(result); return { ...result, echoed: echoSessions.has(req.sessionId) };
      })();
      flight = work; try { return await work; } finally { if (flight === work) flight = null; }
    });
    const onResult = (event: Electron.IpcMainEvent, raw: unknown): void => {
      if (event.sender !== wc || event.senderFrame !== frame) return;
      try {
        current();
        const proof = raw as Record<string, unknown>;
        if (proof.nonce === nonce && typeof proof.failed === 'string') throw new Error(proof.failed.slice(0, 256));
        if (proof.nonce !== nonce || flight || commandProbeFailed || !parseFunctionalSmokeResult(proof.finalFunctional)?.ok) throw new Error('runtime nonce/functionality mismatch');
        const state = proof.state as { standardId: string; chiefPaneId: string; conversation: unknown; memoryId: string; marker: string };
        if (!state || state.marker !== config.gatewayNonce || typeof state.memoryId !== 'string') throw new Error('runtime state absent');
        const liveHistory = history as Array<{ missionId?: string; agents?: Array<{ paneId: string; role: string; conversation: unknown }> }>;
        const chief = liveHistory.filter(h => h.missionId === state.standardId).flatMap(h => h.agents ?? []).find(a => a.role === 'orchestrator' && a.paneId === state.chiefPaneId && sameRuntimeConversation(a.conversation, state.conversation));
        if (!chief || config.phase === 'resume' && JSON.stringify(state) !== JSON.stringify(prior)) throw new Error('runtime native state differs from Main history');
        const memoryIds = getWorkspaceMemoryStore(scope).recall({ query: `RT_MEMORY_${config.gatewayNonce}`, includeGlobal: false }).filter(h => h.content.includes(config.gatewayNonce) && h.scope === 'workspace').map(h => h.id);
        const facts = { phase: config.phase, history, terminated: [...terminated], memoryIds, marker: config.gatewayNonce, state,
          resumedOutput: [...resumedOutput], echoSessions: [...echoSessions], visibleQuestions: [...visibleQuestions], visibleMoves: [...visibleMoves], questionCommands, voice };
        const checks = deriveRuntimeChecks(facts);
        const actualVoice = voice.final ? { ...voice.final, grant: systemPreferences.getMediaAccessStatus('microphone') } : undefined;
        assertRuntimeProof({ ...proof, checks, voice: actualVoice, pid: process.pid, packaged: true, appVersion: input.appVersion, cli }, config.phase);
        const receipt = { ...proof, checks, voice: actualVoice, schema: 'nexus.runtime-gates/v1', pid: process.pid, rendererPid: wc.getOSProcessId(), packaged: true,
          appVersion: input.appVersion, electronVersion: process.versions.electron, cli, facts, captures: [...captures.values()], finalFunctional: proof.finalFunctional };
        flight = (async () => {
          const logs = path.join(input.userData, 'logs'); await fs.mkdir(logs, { recursive: true, mode: 0o700 }); current();
          await fs.writeFile(path.join(logs, `runtime-gates-${config.phase}.json`), JSON.stringify(receipt) + '\n', { mode: 0o600, flag: 'wx' }); current();
          if (config.phase === 'exercise') { await fs.writeFile(statePath, JSON.stringify(state) + '\n', { mode: 0o600, flag: 'wx' }); current(); }
          console.log(`[smoke] runtime-${config.phase}-ready: Main observations and repeated functionality proven`);
          stopped = true; cleanup(); resolve();
        })().catch(() => fail());
      } catch (error) { fail(error instanceof Error ? error.message : 'runtime result refused'); }
    };
    const timer = setTimeout(fail, RUNTIME_TIMEOUT_MS);
    input.ipc.on(RUNTIME_CHANNELS.result, onResult); input.signal.addEventListener('abort', onAbort, { once: true }); wc.once('render-process-gone', onGone); win.once('closed', onGone);
    check(); wc.send(RUNTIME_CHANNELS.run, { nonce, phase: config.phase, workspacePath: input.workspacePath, gatewayNonce: config.gatewayNonce, prior });
  }); } finally { releaseConsent(); }
}
