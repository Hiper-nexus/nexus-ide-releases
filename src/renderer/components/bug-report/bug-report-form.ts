import type {
  BugReportCategory,
  BugReportImpact,
  BugReportMarkdownInput,
  BugReportRequest,
} from '../../../shared/bug-report';

/** O que a pessoa digita e escolhe no diálogo. Vive só no componente. */
export interface BugReportFormState {
  title: string;
  description: string;
  steps: string;
  category: BugReportCategory;
  impact: BugReportImpact;
  includeDiagnostics: boolean;
}

export const INITIAL_BUG_REPORT_FORM: BugReportFormState = {
  title: '',
  description: '',
  steps: '',
  category: 'other',
  impact: 'annoying',
  // Consentimento é uma escolha ativa: nasce desligado.
  includeDiagnostics: false,
};

/** Pedido ao Main. O id do pane em foco só segue junto com o consentimento. */
export function toBugReportRequest(
  form: BugReportFormState,
  activePaneId?: string | null,
): BugReportRequest {
  const steps = form.steps.trim();
  return {
    title: form.title.trim(),
    description: form.description.trim(),
    ...(steps ? { steps } : {}),
    category: form.category,
    impact: form.impact,
    includeDiagnostics: form.includeDiagnostics,
    ...(form.includeDiagnostics && activePaneId ? { activePaneId } : {}),
  };
}

/** Relato só com o que foi digitado: usado quando o Main não devolveu o corpo. */
export function toMarkdownDraft(form: BugReportFormState): BugReportMarkdownInput {
  const steps = form.steps.trim();
  return {
    title: form.title.trim(),
    description: form.description.trim(),
    ...(steps ? { steps } : {}),
    category: form.category,
    impact: form.impact,
  };
}
