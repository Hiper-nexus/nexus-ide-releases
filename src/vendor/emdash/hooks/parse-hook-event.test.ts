// Vendored from generalaction/emdash@c1af543 — Apache-2.0
// See src/vendor/emdash/hooks/LICENSE.md.
// NOTE: upstream has no dedicated parse-hook-event unit test (the default
// parser is exercised indirectly through plugin tests). This suite is a Nexus
// addition that pins the documented routing table of defaultHookEventParser
// directly, since the Nexus /hook/status endpoint depends on it standalone.

import { describe, expect, it } from 'vitest';
import {
  defaultHookEventParser,
  extractProviderSessionId,
} from './parse-hook-event';

describe('extractProviderSessionId', () => {
  it('picks the first non-empty candidate', () => {
    expect(extractProviderSessionId({ session_id: '  abc  ' })).toBe('abc');
    expect(extractProviderSessionId({ provider_session_id: 'p1' })).toBe('p1');
    expect(extractProviderSessionId({ providerSessionId: 'p2' })).toBe('p2');
    expect(extractProviderSessionId({ sessionId: 'p3' })).toBe('p3');
    expect(
      extractProviderSessionId({ session_id: '   ', providerSessionId: 'fallback' }),
    ).toBe('fallback');
  });

  it('returns undefined when no candidate is usable', () => {
    expect(extractProviderSessionId({})).toBeUndefined();
    expect(extractProviderSessionId({ session_id: 42 })).toBeUndefined();
  });
});

describe('defaultHookEventParser', () => {
  it('routes session events to kind session when an id is present', () => {
    expect(defaultHookEventParser('session', { session_id: 's1' })).toEqual({
      kind: 'session',
      providerSessionId: 's1',
    });
    expect(defaultHookEventParser('session-start', { sessionId: 's2' })).toEqual({
      kind: 'session',
      providerSessionId: 's2',
    });
  });

  it('ignores session events without an id', () => {
    expect(defaultHookEventParser('session', {})).toEqual({ kind: 'ignore' });
  });

  it('routes start/stop/error to status with matching type', () => {
    for (const type of ['start', 'stop', 'error'] as const) {
      expect(defaultHookEventParser(type, {})).toMatchObject({ kind: 'status', type });
    }
  });

  it('carries title/message/lastAssistantMessage when present', () => {
    expect(
      defaultHookEventParser('stop', {
        title: 't',
        message: 'm',
        last_assistant_message: 'done here',
      }),
    ).toEqual({
      kind: 'status',
      type: 'stop',
      title: 't',
      message: 'm',
      lastAssistantMessage: 'done here',
    });
  });

  it('routes notification with a known notification_type', () => {
    expect(
      defaultHookEventParser('notification', { notification_type: 'permission_prompt' }),
    ).toMatchObject({
      kind: 'status',
      type: 'notification',
      notificationType: 'permission_prompt',
    });
    expect(
      defaultHookEventParser('notification', { notificationType: 'idle_prompt' }),
    ).toMatchObject({ notificationType: 'idle_prompt' });
  });

  it('drops an unknown notification_type to undefined', () => {
    const event = defaultHookEventParser('notification', { notification_type: 'bogus' });
    expect(event).toMatchObject({ kind: 'status', type: 'notification' });
    expect(
      event.kind === 'status' && event.type === 'notification'
        ? event.notificationType
        : 'x',
    ).toBeUndefined();
  });

  it('ignores unknown event types', () => {
    expect(defaultHookEventParser('unknown-event', {})).toEqual({ kind: 'ignore' });
    expect(defaultHookEventParser('', {})).toEqual({ kind: 'ignore' });
  });
});
