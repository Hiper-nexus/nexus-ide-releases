import { describe, expect, it } from 'vitest';
import { unwrapDoctorDiagnosticOutput } from './doctor-diagnostic-engine';

describe('Doctor diagnostic output', () => {
  it('extracts Grok structured output from its CLI envelope', () => {
    expect(unwrapDoctorDiagnosticOutput(JSON.stringify({
      text: '{"ok":true}',
      structuredOutput: { ok: true },
      thought: 'internal metadata',
    }))).toBe('{"ok":true}');
  });

  it('accepts raw provider JSON for forward-compatible adapters', () => {
    expect(unwrapDoctorDiagnosticOutput('{"name":"Squad"}')).toBe('{"name":"Squad"}');
  });

  it('surfaces a structured-output failure instead of pretending success', () => {
    expect(() => unwrapDoctorDiagnosticOutput(JSON.stringify({
      text: '',
      structuredOutput: null,
      structuredOutputError: 'model did not produce structured output',
    }))).toThrow('model did not produce structured output');
  });
});
