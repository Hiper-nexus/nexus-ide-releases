import { describe, expect, it } from 'vitest';
import {
  INITIAL_BUG_REPORT_FORM,
  toBugReportRequest,
  toMarkdownDraft,
  type BugReportFormState,
} from './bug-report-form';
import { bugReportRequestSchema } from '../../../shared/bug-report';

const filled: BugReportFormState = {
  ...INITIAL_BUG_REPORT_FORM,
  title: '  O terminal trava ao colar  ',
  description: '  Ao colar um texto longo o pane congela.  ',
  steps: '   ',
  category: 'terminal',
  impact: 'blocks_work',
};

describe('INITIAL_BUG_REPORT_FORM', () => {
  it('starts with diagnostics OFF and the milder impact', () => {
    expect(INITIAL_BUG_REPORT_FORM.includeDiagnostics).toBe(false);
    expect(INITIAL_BUG_REPORT_FORM.impact).toBe('annoying');
    expect(INITIAL_BUG_REPORT_FORM.title).toBe('');
  });
});

describe('toBugReportRequest', () => {
  it('trims text and drops blank steps', () => {
    const request = toBugReportRequest(filled);
    expect(request).toEqual({
      title: 'O terminal trava ao colar',
      description: 'Ao colar um texto longo o pane congela.',
      category: 'terminal',
      impact: 'blocks_work',
      includeDiagnostics: false,
    });
    expect(bugReportRequestSchema.safeParse(request).success).toBe(true);
  });

  it('keeps non-blank steps', () => {
    expect(toBugReportRequest({ ...filled, steps: ' 1. Colar\n2. Esperar ' }).steps).toBe('1. Colar\n2. Esperar');
  });

  it('only forwards the focused pane id when diagnostics are on', () => {
    expect(toBugReportRequest(filled, 'pane-1')).not.toHaveProperty('activePaneId');
    const withConsent = toBugReportRequest({ ...filled, includeDiagnostics: true }, 'pane-1');
    expect(withConsent.activePaneId).toBe('pane-1');
    expect(toBugReportRequest({ ...filled, includeDiagnostics: true }, null)).not.toHaveProperty('activePaneId');
  });
});

describe('toMarkdownDraft', () => {
  it('shapes the form as a report without app information', () => {
    const draft = toMarkdownDraft({ ...filled, steps: '1. Colar' });
    expect(draft).toMatchObject({
      title: 'O terminal trava ao colar',
      steps: '1. Colar',
      category: 'terminal',
      impact: 'blocks_work',
    });
    expect(draft).not.toHaveProperty('app');
    expect(draft).not.toHaveProperty('diagnostics');
  });
});
