import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { RUNTIME_DOM_REQUEST, RUNTIME_DOM_REPLY } from '../shared/runtime-gates';
const native = vi.hoisted(() => ({ spawn: vi.fn(() => 'ordinary-pane'), session: vi.fn(async () => 'ordinary-session'), open: vi.fn(),
  current: vi.fn(() => 'ordinary-session'), confirmed: vi.fn(async () => true), operator: vi.fn(async () => true),
  promptState: vi.fn(async () => ({ turnStartSequence: 0, state: 'idle', awaitingInput: false } as import('../shared/types').PtyPromptState | null)) }));
vi.mock('./state/layout-store', () => ({ useLayoutStore: { getState: () => ({ spawnAgent: native.spawn }) } }));
vi.mock('./terminal/terminal-host', () => ({ waitForSession: native.session, getPaneSessionId: native.current,
  submitPromptToPaneConfirmed: native.confirmed, submitPromptToPaneOperatorInput: native.operator }));
vi.mock('./lib/split-tree', () => ({ listPanes: () => [{ id: 'ordinary-pane', kind: 'cli-agent', adapterId: 'claude' }] }));
vi.mock('./state/product-navigation-store', () => ({ useProductNavigationStore: { getState: () => ({ openTerminal: native.open, openMission: native.open }) } }));
beforeEach(() => { native.current.mockReturnValue('ordinary-session'); native.promptState.mockReset().mockResolvedValue({ turnStartSequence: 0, state: 'idle', awaitingInput: false }); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.resetModules(); vi.clearAllMocks(); });
it.each(['nexus-app://bundle/index.html', 'https://foreign.invalid/index.html?nexusRuntimeGates=1', 'nexus-app://bundle/other.html?nexusRuntimeGates=1'])('remains dormant on %s, including a later marker edit', async href => {
  vi.stubGlobal('location', { href }); const add = vi.fn(); vi.stubGlobal('window', { addEventListener: add });
  const { installRuntimeGateRenderer, isRuntimeRendererUrl } = await import('./runtime-gates');
  expect(isRuntimeRendererUrl(href)).toBe(false); location.href = 'nexus-app://bundle/index.html?nexusRuntimeGates=1'; installRuntimeGateRenderer();
  expect(add).not.toHaveBeenCalled();
});
it('observes the same actual capture objects and graph states, restores wrappers and never stores PCM', async () => {
  vi.stubGlobal('location', { href: 'nexus-app://bundle/index.html?nexusRuntimeGates=1' });
  const win = Object.assign(new EventTarget(), { AudioContext: class { state = 'running'; }, AudioWorkletNode: class { port = Object.assign(new EventTarget(), { start: vi.fn() }); } });
  const track = { id: 'native-track-id', kind: 'audio', readyState: 'live' }, media = vi.fn(async () => ({ getTracks: () => [track] }));
  vi.stubGlobal('window', win); vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: media } });
  const OriginalContext = win.AudioContext, OriginalWorklet = win.AudioWorkletNode;
  const { installRuntimeGateRenderer } = await import('./runtime-gates'); installRuntimeGateRenderer();
  let sequence = 0;
  const send = (operation: string) => new Promise<any>(resolve => {
    const request = sequence++; const reply = (event: Event) => { const detail = (event as CustomEvent).detail; if (detail.request !== request) return; win.removeEventListener(RUNTIME_DOM_REPLY, reply); expect(detail.ok).toBe(true); resolve(detail.result); };
    win.addEventListener(RUNTIME_DOM_REPLY, reply); win.dispatchEvent(new CustomEvent(RUNTIME_DOM_REQUEST, { detail: { nonce: '11111111-1111-4111-8111-111111111111', request, operation } }));
  });
  await send('media-observe'); await navigator.mediaDevices.getUserMedia({ audio: true });
  const context = new win.AudioContext(), node = new win.AudioWorkletNode(); node.port.dispatchEvent(new Event('message'));
  const active = await send('media-state'); expect(active.tracks).toEqual([{ id: track.id, kind: 'audio', state: 'live' }]); expect(active.frames).toBe(1);
  track.readyState = 'ended'; context.state = 'closed'; const ended = await send('media-state');
  expect(ended.tracks[0].id).toBe(active.tracks[0].id); expect(ended.contexts[0].id).toBe(active.contexts[0].id); expect(ended.contexts[0].state).toBe('closed');
  expect(Object.keys(ended).sort()).toEqual(['contexts', 'frames', 'tracks']); await send('media-cleanup');
  expect(navigator.mediaDevices.getUserMedia).toBe(media); expect(win.AudioContext).toBe(OriginalContext); expect(win.AudioWorkletNode).toBe(OriginalWorklet);
});
it.each(['catalog-model', undefined])('F-1113/F-1119: normal operator pane preserves explicit or omitted model (%s)', async model => {
  vi.stubGlobal('location', { href: 'nexus-app://bundle/index.html?nexusRuntimeGates=1' });
  const win = new EventTarget(); vi.stubGlobal('window', win);
  vi.stubGlobal('requestAnimationFrame', (callback: () => void) => { callback(); return 1; });
  const { installRuntimeGateRenderer } = await import('./runtime-gates'); installRuntimeGateRenderer();
  const replied = new Promise<any>(resolve => win.addEventListener(RUNTIME_DOM_REPLY, event => resolve((event as CustomEvent).detail), { once: true }));
  win.dispatchEvent(new CustomEvent(RUNTIME_DOM_REQUEST, { detail: { nonce: '11111111-1111-4111-8111-111111111111', request: 0, operation: 'operator-pane', ...(model === undefined ? {} : { model }) } }));
  expect(await replied).toMatchObject({ ok: true, result: { paneId: 'ordinary-pane', sessionId: 'ordinary-session' } });
  expect(native.spawn).toHaveBeenCalledWith('claude', model ?? '');
});
it.each(['user-prompt', 'mission-prompt', 'foreign-session'] as const)('F-1118: finite normal prompt uses the correct exact-session submission lane (%s)', async operation => {
  vi.stubGlobal('location', { href: 'nexus-app://bundle/index.html?nexusRuntimeGates=1' });
  const win = Object.assign(new EventTarget(), { nexus: { pty: { promptState: native.promptState } } }); vi.stubGlobal('window', win);
  const { installRuntimeGateRenderer } = await import('./runtime-gates'); installRuntimeGateRenderer();
  const replied = new Promise<any>(resolve => win.addEventListener(RUNTIME_DOM_REPLY, e => resolve((e as CustomEvent).detail), { once: true }));
  const text = 'RT_GATE WRITE 11111111-1111-4111-8111-111111111111';
  win.dispatchEvent(new CustomEvent(RUNTIME_DOM_REQUEST, { detail: { nonce: '11111111-1111-4111-8111-111111111111', request: 1,
    operation: operation === 'foreign-session' ? 'mission-prompt' : operation, paneId: 'ordinary-pane', sessionId: operation === 'foreign-session' ? 'foreign' : 'ordinary-session', text } }));
  expect(await replied).toMatchObject({ ok: operation !== 'foreign-session' });
  if (operation === 'foreign-session') { expect(native.operator).not.toHaveBeenCalled(); expect(native.confirmed).not.toHaveBeenCalled(); }
  else expect(operation === 'user-prompt' ? native.confirmed : native.operator).toHaveBeenCalledWith('ordinary-pane', text, 'ordinary-session');
});

async function privatePrompt(operation: 'user-prompt' | 'mission-prompt' = 'user-prompt') {
  vi.stubGlobal('location', { href: 'nexus-app://bundle/index.html?nexusRuntimeGates=1' });
  const win = Object.assign(new EventTarget(), { nexus: { pty: { promptState: native.promptState } } });
  vi.stubGlobal('window', win);
  const { installRuntimeGateRenderer } = await import('./runtime-gates'); installRuntimeGateRenderer();
  const replied = new Promise<{ ok: boolean }>(resolve => win.addEventListener(RUNTIME_DOM_REPLY, e => resolve((e as CustomEvent).detail), { once: true }));
  win.dispatchEvent(new CustomEvent(RUNTIME_DOM_REQUEST, { detail: { nonce: '11111111-1111-4111-8111-111111111111', request: 1,
    operation, paneId: 'ordinary-pane', sessionId: 'ordinary-session', text: 'RT_GATE CREATE once' } }));
  await vi.dynamicImportSettled();
  return { replied };
}

it.each([['user-prompt', 'busy'], ['mission-prompt', 'busy'], ['user-prompt', 'spawning'], ['mission-prompt', 'spawning']] as const)('F-1122: %s waits from Main %s until idle readiness before one payload', async (operation, initial) => {
  vi.useFakeTimers();
  let ready!: (state: import('../shared/types').PtyPromptState) => void;
  native.promptState.mockResolvedValueOnce({ turnStartSequence: 0, state: initial, awaitingInput: false })
    .mockReturnValueOnce(new Promise(resolve => { ready = resolve; }));
  const { replied } = await privatePrompt(operation);
  await vi.advanceTimersByTimeAsync(400);
  expect(native.confirmed).not.toHaveBeenCalled(); expect(native.operator).not.toHaveBeenCalled();
  ready({ turnStartSequence: 0, state: 'idle', awaitingInput: false });
  expect(await replied).toMatchObject({ ok: true });
  expect(operation === 'user-prompt' ? native.confirmed : native.operator).toHaveBeenCalledExactlyOnceWith('ordinary-pane', 'RT_GATE CREATE once', 'ordinary-session');
});

it.each(['null', 'dialog', 'exited', 'rebind', 'revoked'] as const)('F-1122: %s readiness refuses before any payload', async fault => {
  native.promptState.mockImplementationOnce(async () => {
    if (fault === 'rebind') native.current.mockReturnValue('rebound-session');
    return fault === 'null' || fault === 'revoked' ? null : { turnStartSequence: 0, state: fault === 'exited' ? 'exited' : 'idle', awaitingInput: fault === 'dialog' };
  });
  const { replied } = await privatePrompt();
  expect(await replied).toMatchObject({ ok: false });
  expect(native.confirmed).not.toHaveBeenCalled(); expect(native.operator).not.toHaveBeenCalled();
});

it('F-1122: an owned composer that stays busy exhausts the existing 45s readiness bound without input', async () => {
  vi.useFakeTimers();
  native.promptState.mockResolvedValue({ turnStartSequence: 0, state: 'busy', awaitingInput: false });
  const { replied } = await privatePrompt();
  await vi.advanceTimersByTimeAsync(45_000);
  expect(await replied).toMatchObject({ ok: false });
  expect(native.confirmed).not.toHaveBeenCalled(); expect(native.operator).not.toHaveBeenCalled();
});

it('F-1122: an unanswered Main readiness probe expires within the same bound without input', async () => {
  vi.useFakeTimers();
  native.promptState.mockReturnValueOnce(new Promise(() => undefined));
  const { replied } = await privatePrompt();
  await vi.advanceTimersByTimeAsync(45_000);
  expect(await replied).toMatchObject({ ok: false });
  expect(native.confirmed).not.toHaveBeenCalled(); expect(native.operator).not.toHaveBeenCalled();
});

it.each([[300, true], [null, false]] as const)('runtime question waits for the asynchronously rendered mission question (render after %s ms → %s)', async (renderAfter, expected) => {
  vi.useFakeTimers();
  vi.stubGlobal('location', { href: 'nexus-app://bundle/index.html?nexusRuntimeGates=1' });
  const win = new EventTarget(); vi.stubGlobal('window', win);
  vi.stubGlobal('requestAnimationFrame', (callback: () => void) => { callback(); return 1; });
  const marker = 'RT_QUESTION_11111111-1111-4111-8111-111111111111', started = Date.now();
  const element = { textContent: `Pergunta ${marker}`, isConnected: true, getBoundingClientRect: () => ({ width: 120, height: 20 }) };
  vi.stubGlobal('document', { querySelectorAll: () => renderAfter !== null && Date.now() - started >= renderAfter ? [element] : [] });
  vi.stubGlobal('getComputedStyle', () => ({ visibility: 'visible', display: 'block', opacity: '1' }));
  const { installRuntimeGateRenderer } = await import('./runtime-gates'); installRuntimeGateRenderer();
  const replied = new Promise<any>(resolve => win.addEventListener(RUNTIME_DOM_REPLY, e => resolve((e as CustomEvent).detail), { once: true }));
  win.dispatchEvent(new CustomEvent(RUNTIME_DOM_REQUEST, { detail: { nonce: '11111111-1111-4111-8111-111111111111', request: 1, operation: 'question', missionId: 'mission-1', marker } }));
  await vi.advanceTimersByTimeAsync(6000);
  expect(await replied).toMatchObject({ ok: true, result: { visible: expected } });
  expect(native.open).toHaveBeenCalledWith('mission-1');
});
