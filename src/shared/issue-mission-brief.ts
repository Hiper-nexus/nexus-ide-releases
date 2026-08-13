import type { ExternalIssue } from './integrations-types';

export function formatIssueMissionTitle(issue: ExternalIssue): string {
  if (issue.number) return `#${issue.number} ${issue.title}`.trim();
  return issue.title.trim();
}

export function formatIssueMissionBrief(issue: ExternalIssue): string {
  const lines = [
    issue.title.trim(),
    '',
    issue.number ? `Issue: #${issue.number}` : null,
    `Fonte (${issue.provider}): ${issue.url || '(sem url)'}`,
    issue.labels.length ? `Labels: ${issue.labels.join(', ')}` : null,
    issue.number ? `Fixes #${issue.number}` : null,
  ];
  return lines.filter((line) => line !== null).join('\n').trim();
}
