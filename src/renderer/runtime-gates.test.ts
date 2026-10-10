import { afterEach, expect, it, vi } from 'vitest';
import { RUNTIME_DOM_REQUEST, RUNTIME_DOM_REPLY } from '../shared/runtime-gates';
const native = vi.hoisted(() => ({ spawn: vi.fn(() => 'ordinary-pane'), session: vi.fn(async () => 'ordinary-session'), open: vi.fn() }));
vi.mock('./state/layout-store', () => ({ useLayoutStore: { getState: () => ({ spawnAgent: native.spawn }) } }));
vi.mock('./terminal/terminal-host', () => ({ waitForSession: native.session }));
vi.mock('./lib/split-tree', () => ({ listPanes: () => [] }));
vi.mock('./state/product-navigation-store', () => ({ useProductNavigationStore: { getState: () => ({ openTerminal: native.open }) } }));
afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });
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
it('F-1113: normal operator pane creation returns the ordinary pane and actual session identity', async () => {
  vi.stubGlobal('location', { href: 'nexus-app://bundle/index.html?nexusRuntimeGates=1' });
  const win = new EventTarget(); vi.stubGlobal('window', win);
  vi.stubGlobal('requestAnimationFrame', (callback: () => void) => { callback(); return 1; });
  const { installRuntimeGateRenderer } = await import('./runtime-gates'); installRuntimeGateRenderer();
  const replied = new Promise<any>(resolve => win.addEventListener(RUNTIME_DOM_REPLY, event => resolve((event as CustomEvent).detail), { once: true }));
  win.dispatchEvent(new CustomEvent(RUNTIME_DOM_REQUEST, { detail: { nonce: '11111111-1111-4111-8111-111111111111', request: 0, operation: 'operator-pane', model: 'catalog-model' } }));
  expect(await replied).toMatchObject({ ok: true, result: { paneId: 'ordinary-pane', sessionId: 'ordinary-session' } });
  expect(native.spawn).toHaveBeenCalledWith('claude', 'catalog-model');
});
