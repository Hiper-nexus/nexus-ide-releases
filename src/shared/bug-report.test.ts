import { describe, expect, it } from 'vitest';
import {
  BUG_REPORT_CATEGORIES,
  BUG_REPORT_LIMITS,
  bugReportPayloadSchema,
  bugReportRequestSchema,
  formatBugReportMarkdown,
  validateBugReportDraft,
  type BugReportPayload,
} from './bug-report';

const validRequest = {
  title: 'O terminal trava ao colar',
  description: 'Ao colar um texto longo o pane congela por alguns segundos.',
  category: 'terminal' as const,
  impact: 'annoying' as const,
  includeDiagnostics: false,
};

const validPayload: BugReportPayload = {
  title: 'O terminal trava ao colar',
  description: 'Ao colar um texto longo o pane congela por alguns segundos.',
  category: 'terminal',
  impact: 'blocks_work',
  app: { version: '0.76.161', platform: 'darwin', arch: 'arm64', osVersion: '27.2.0' },
  consent: { diagnostics: false },
};

describe('bugReportRequestSchema', () => {
  it('accepts a minimal valid request', () => {
    expect(bugReportRequestSchema.safeParse(validRequest).success).toBe(true);
  });

  it('rejects unknown keys (strict)', () => {
    const result = bugReportRequestSchema.safeParse({ ...validRequest, token: 'x' });
    expect(result.success).toBe(false);
  });

  it('rejects out-of-range text and unknown enums', () => {
    const bad = [
      { ...validRequest, title: 'abcd' },
      { ...validRequest, title: 'x'.repeat(BUG_REPORT_LIMITS.titleMax + 1) },
      { ...validRequest, description: 'curta' },
      { ...validRequest, description: 'x'.repeat(BUG_REPORT_LIMITS.descriptionMax + 1) },
      { ...validRequest, steps: 'x'.repeat(BUG_REPORT_LIMITS.stepsMax + 1) },
      { ...validRequest, category: 'security' },
      { ...validRequest, impact: 'critical' },
      { ...validRequest, includeDiagnostics: 'yes' },
    ];
    const results = bad.map((candidate) => bugReportRequestSchema.safeParse(candidate).success);
    expect(results).toEqual([false, false, false, false, false, false, false, false]);
  });

  it('accepts a title of exactly the minimum length', () => {
    expect(bugReportRequestSchema.safeParse({ ...validRequest, title: 'curto' }).success).toBe(true);
  });

  it('trims whitespace before measuring', () => {
    const result = bugReportRequestSchema.safeParse({ ...validRequest, title: '   abc   ' });
    expect(result.success).toBe(false);
  });

  it('requires includeDiagnostics to be an explicit boolean', () => {
    const { includeDiagnostics: _omitted, ...withoutConsent } = validRequest;
    expect(bugReportRequestSchema.safeParse(withoutConsent).success).toBe(false);
  });

  it('accepts an optional preview digest and nothing else shaped like it', () => {
    const digest = 'a'.repeat(64);
    expect(bugReportRequestSchema.safeParse({ ...validRequest, previewDigest: digest }).success).toBe(true);
    for (const bad of ['', 'A'.repeat(64), 'a'.repeat(63), `${'a'.repeat(63)}g`, 5]) {
      expect(bugReportRequestSchema.safeParse({ ...validRequest, previewDigest: bad }).success).toBe(false);
    }
  });

  it('lists every category of the v1 contract', () => {
    expect([...BUG_REPORT_CATEGORIES]).toEqual([
      'crash', 'terminal', 'agents', 'license', 'billing', 'ui', 'performance', 'other',
    ]);
  });
});

describe('bugReportPayloadSchema (wire contract v1)', () => {
  it('accepts a payload without diagnostics when consent is off', () => {
    expect(bugReportPayloadSchema.safeParse(validPayload).success).toBe(true);
  });

  it('accepts diagnostics when consent is on', () => {
    const payload = {
      ...validPayload,
      consent: { diagnostics: true },
      context: { adapter: 'claude', model: 'opus', paneCount: 3, missionActive: true },
      diagnostics: { events: [{ t: 1_700_000_000_000, kind: 'main-boot' }], errors: ['pty-error:E1'] },
    };
    expect(bugReportPayloadSchema.safeParse(payload).success).toBe(true);
  });

  it('refuses diagnostics or context without consent', () => {
    const withDiagnostics = {
      ...validPayload,
      diagnostics: { events: [], errors: [] },
    };
    const withContext = {
      ...validPayload,
      context: { paneCount: 1, missionActive: false },
    };
    expect(bugReportPayloadSchema.safeParse(withDiagnostics).success).toBe(false);
    expect(bugReportPayloadSchema.safeParse(withContext).success).toBe(false);
  });

  it('enforces list and string caps of the contract', () => {
    const base = { ...validPayload, consent: { diagnostics: true } };
    const tooManyEvents = {
      ...base,
      diagnostics: {
        events: Array.from({ length: 51 }, (_, index) => ({ t: index, kind: 'k' })),
        errors: [],
      },
    };
    const tooManyErrors = {
      ...base,
      diagnostics: { events: [], errors: Array.from({ length: 21 }, () => 'e') },
    };
    const longError = {
      ...base,
      diagnostics: { events: [], errors: ['e'.repeat(201)] },
    };
    const longKind = {
      ...base,
      diagnostics: { events: [{ t: 1, kind: 'k'.repeat(41) }], errors: [] },
    };
    const longCode = {
      ...base,
      diagnostics: { events: [{ t: 1, kind: 'k', code: 'c'.repeat(81) }], errors: [] },
    };
    const bigPanes = { ...base, context: { paneCount: 65, missionActive: false } };
    const outcomes = [tooManyEvents, tooManyErrors, longError, longKind, longCode, bigPanes].map(
      (candidate) => bugReportPayloadSchema.safeParse(candidate).success,
    );
    expect(outcomes).toEqual([false, false, false, false, false, false]);
  });

  it('rejects extra keys anywhere in the payload', () => {
    const extraTop = { ...validPayload, extra: 1 };
    const extraApp = { ...validPayload, app: { ...validPayload.app, hostname: 'mac' } };
    expect(bugReportPayloadSchema.safeParse(extraTop).success).toBe(false);
    expect(bugReportPayloadSchema.safeParse(extraApp).success).toBe(false);
  });

  it('keeps event timestamps inside the range of a JS Date', () => {
    const base = { ...validPayload, consent: { diagnostics: true } };
    const make = (t: number) => ({
      ...base,
      diagnostics: { events: [{ t, kind: 'k' }], errors: [] },
    });
    expect(bugReportPayloadSchema.safeParse(make(8.64e15)).success).toBe(true);
    expect(bugReportPayloadSchema.safeParse(make(8.64e15 + 1)).success).toBe(false);
    expect(bugReportPayloadSchema.safeParse(make(Number.MAX_SAFE_INTEGER)).success).toBe(false);
  });

  it('only allows the three desktop platforms', () => {
    const freebsd = { ...validPayload, app: { ...validPayload.app, platform: 'freebsd' } };
    expect(bugReportPayloadSchema.safeParse(freebsd).success).toBe(false);
  });
});

describe('validateBugReportDraft', () => {
  it('returns no errors for a valid draft', () => {
    expect(validateBugReportDraft(validRequest)).toEqual({});
  });

  it('explains each invalid field in Portuguese', () => {
    const errors = validateBugReportDraft({
      ...validRequest,
      title: 'abc',
      description: 'curta',
    });
    expect(errors.title).toMatch(/pelo menos 5/);
    expect(errors.description).toMatch(/pelo menos 10/);
    expect(errors.steps).toBeUndefined();
  });

  it('flags text that is too long', () => {
    const errors = validateBugReportDraft({
      ...validRequest,
      description: 'x'.repeat(BUG_REPORT_LIMITS.descriptionMax + 1),
      steps: 'x'.repeat(BUG_REPORT_LIMITS.stepsMax + 1),
    });
    expect(errors.description).toMatch(/4000/);
    expect(errors.steps).toMatch(/2000/);
  });
});

describe('formatBugReportMarkdown', () => {
  it('renders the typed report without diagnostics when consent is off', () => {
    const markdown = formatBugReportMarkdown({ ...validPayload, steps: '1. Colar\n2. Esperar' });
    expect(markdown).toContain('# O terminal trava ao colar');
    expect(markdown).toContain('Categoria: Terminal');
    expect(markdown).toContain('Impacto: Me impede de trabalhar');
    expect(markdown).toContain('NexusIDE 0.76.161');
    expect(markdown).toContain('## Passos para reproduzir');
    expect(markdown).not.toContain('Diagnóstico técnico');
  });

  it('includes context, events and errors when diagnostics are present', () => {
    const payload: BugReportPayload = {
      ...validPayload,
      consent: { diagnostics: true },
      context: { adapter: 'claude', model: 'opus', paneCount: 2, missionActive: true },
      diagnostics: {
        events: [{ t: Date.UTC(2026, 9, 1, 12, 0, 0), kind: 'agent-pty-exit', code: '1' }],
        errors: ['agent-pty-exit:1'],
      },
    };
    const markdown = formatBugReportMarkdown(payload);
    expect(markdown).toContain('## Diagnóstico técnico');
    expect(markdown).toContain('claude');
    expect(markdown).toContain('2026-10-01T12:00:00.000Z');
    expect(markdown).toContain('agent-pty-exit');
    expect(markdown).toContain('Erros recentes');
  });

  it('never throws on an event time outside the Date range', () => {
    const payload: BugReportPayload = {
      ...validPayload,
      consent: { diagnostics: true },
      diagnostics: { events: [{ t: Number.MAX_SAFE_INTEGER, kind: 'agent-pty-exit' }], errors: [] },
    };
    expect(() => formatBugReportMarkdown(payload)).not.toThrow();
    expect(formatBugReportMarkdown(payload)).toContain('agent-pty-exit');
  });

  it('omits the steps section when there are none and tolerates a draft without app info', () => {
    const markdown = formatBugReportMarkdown({
      title: validPayload.title,
      description: validPayload.description,
      category: 'other',
      impact: 'annoying',
    });
    expect(markdown).not.toContain('Passos para reproduzir');
    expect(markdown).not.toContain('NexusIDE');
  });
});
