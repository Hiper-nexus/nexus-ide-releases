import { describe, expect, it } from 'vitest';
import { buildRealtimeEngageDecision } from './engage-decision';

describe('buildRealtimeEngageDecision', () => {
  it('engages the first provider whose key is present (gemini stored)', () => {
    const d = buildRealtimeEngageDecision({
      transport: 'gemini-live',
      candidates: [
        { id: 'gemini', envVar: 'GEMINI_API_KEY', source: 'stored' },
        { id: 'openai', envVar: 'OPENAI_API_KEY', source: 'env' },
      ],
    });
    expect(d.engaged).toBe('gemini');
    expect(d.degraded).toBe(false);
    expect(d.line).toContain('transport=gemini-live');
    expect(d.line).toContain('engaged=gemini');
    // presence + source only, never a value
    expect(d.line).toContain('GEMINI_API_KEY=stored');
    expect(d.line).toContain('OPENAI_API_KEY=env');
  });

  it('falls back to openai-realtime when gemini has no key but openai does', () => {
    const d = buildRealtimeEngageDecision({
      transport: 'gemini-live',
      candidates: [
        { id: 'gemini', envVar: 'GEMINI_API_KEY', source: 'missing' },
        { id: 'openai', envVar: 'OPENAI_API_KEY', source: 'stored' },
      ],
    });
    expect(d.engaged).toBe('openai');
    expect(d.degraded).toBe(false);
    expect(d.line).toContain('engaged=openai');
    expect(d.line).toContain('GEMINI_API_KEY=missing');
  });

  it('degrades to Classic with a reason when no candidate has a key', () => {
    const d = buildRealtimeEngageDecision({
      transport: 'gemini-live',
      candidates: [
        { id: 'gemini', envVar: 'GEMINI_API_KEY', source: 'missing' },
        { id: 'openai', envVar: 'OPENAI_API_KEY', source: 'missing' },
      ],
    });
    expect(d.engaged).toBe(null);
    expect(d.degraded).toBe(true);
    expect(d.line).toContain('engaged=classic');
    expect(d.reason).toMatch(/no realtime key/i);
  });

  it('degrades when the transport itself is classic (no candidates)', () => {
    const d = buildRealtimeEngageDecision({ transport: 'classic', candidates: [] });
    expect(d.engaged).toBe(null);
    expect(d.degraded).toBe(true);
    expect(d.line).toContain('transport=classic');
  });

  it('is stable across repeated calls (usable as a dedupe key)', () => {
    const input = {
      transport: 'gemini-live' as const,
      candidates: [{ id: 'gemini' as const, envVar: 'GEMINI_API_KEY', source: 'stored' as const }],
    };
    expect(buildRealtimeEngageDecision(input).line).toBe(
      buildRealtimeEngageDecision(input).line,
    );
  });
});
