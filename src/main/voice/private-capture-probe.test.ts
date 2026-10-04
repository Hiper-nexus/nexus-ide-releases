import { expect, it, vi } from 'vitest';
const deps = vi.hoisted(() => ({ scope: null as unknown }));
vi.mock('../persistence/renderer-workspace-scope', () => ({ getRendererWorkspaceScope: () => deps.scope }));
import { armPrivateCaptureProbe, privateCaptureProbeAllowed, privateCaptureMediaPermission } from './private-capture-probe';
it('requires preexisting OS grant and the same live window/frame/scope; release blocks late callers', () => {
  const frame = { url: 'nexus-app://app/index.html?nexusRuntimeGates=1' }, scope = { installationId: 'i', projectId: 'p', checkoutId: 'c', rootRealPath: '/private' };
  const wc = { mainFrame: frame, isDestroyed: () => false, getURL: () => frame.url };
  deps.scope = scope;
  expect(() => armPrivateCaptureProbe(wc as never, scope as never, 'nonce', 'denied')).toThrow();
  const release = armPrivateCaptureProbe(wc as never, scope as never, 'nonce', 'granted');
  expect(privateCaptureProbeAllowed(wc as never, frame as never)).toBe(true); expect(privateCaptureProbeAllowed({} as never, frame as never)).toBe(false);
  expect(privateCaptureProbeAllowed(wc as never, {} as never)).toBe(false); expect(privateCaptureProbeAllowed(wc as never)).toBe(false);
  wc.mainFrame = { url: 'foreign' }; expect(privateCaptureProbeAllowed(wc as never)).toBe(false); wc.mainFrame = frame;
  deps.scope = { ...scope, projectId: 'foreign' }; expect(privateCaptureProbeAllowed()).toBe(false); deps.scope = scope;
  release(); expect(privateCaptureProbeAllowed()).toBe(false);
});
it('authorizes only audio from the exact leased main-frame entry URL, including permission checks', () => {
  const url = 'nexus-app://app/index.html?nexusRuntimeGates=1';
  const frame = { url }, scope = { installationId: 'i', projectId: 'p', checkoutId: 'c', rootRealPath: '/private' };
  const wc = { mainFrame: frame, isDestroyed: () => false, getURL: () => frame.url };
  deps.scope = scope;
  const release = armPrivateCaptureProbe(wc as never, scope as never, 'nonce', 'granted');
  const details = { isMainFrame: true, requestingUrl: url, mediaTypes: ['audio'], securityOrigin: 'nexus-app://app' };
  try {
    expect(privateCaptureMediaPermission(wc as never, 'media', details, 'request', 'granted')).toBe(true);
    expect(privateCaptureMediaPermission(wc as never, 'media', { ...details, mediaType: 'audio' }, 'check', 'granted')).toBe(true);
    for (const change of [{ mediaTypes: ['video'] }, { mediaTypes: ['audio', 'video'] }, { mediaTypes: [] }, { mediaTypes: undefined },
      { isMainFrame: false }, { requestingUrl: `${url}x` }, { securityOrigin: 'https://foreign.invalid' }]) {
      expect(privateCaptureMediaPermission(wc as never, 'media', { ...details, ...change }, 'request', 'granted')).toBe(false);
    }
    for (const mediaType of ['video', 'unknown', undefined]) expect(privateCaptureMediaPermission(wc as never, 'media', { ...details, mediaType }, 'check', 'granted')).toBe(false);
    expect(privateCaptureMediaPermission(wc as never, 'media', details, 'request', 'denied')).toBe(false);
    frame.url = `${url}changed`; expect(privateCaptureMediaPermission(wc as never, 'media', details, 'request', 'granted')).toBe(false); frame.url = url;
    deps.scope = { ...scope, checkoutId: 'new' }; expect(privateCaptureMediaPermission(wc as never, 'media', details, 'request', 'granted')).toBe(false); deps.scope = scope;
  } finally { release(); }
  expect(privateCaptureMediaPermission(wc as never, 'media', details, 'request', 'granted')).toBe(false);
});
