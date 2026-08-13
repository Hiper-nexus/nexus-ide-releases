// Adapted from stablyai/orca @ 93334dc53fccdb7348d09fc28067ba6d3dec36ea
// (src/shared/pull-request-generation.ts).
// Copyright (c) 2026 Lovecast Inc. — MIT License
// See third_party/licenses/orca-MIT.txt.
// Nexus changes: gerador LOCAL honesto (commits + branch + issue) como
// caminho principal; parse JSON fica como upgrade opcional se um LLM
// devolver o mesmo shape. Sem exigir modelo.

import type { GitLogEntry } from './git-scm';

export type GeneratedPullRequestFields = {
  base: string;
  title: string;
  body: string;
  draft: boolean;
};

export type PullRequestDraftContext = {
  branch: string | null;
  base: string;
  commits: GitLogEntry[];
  linkedIssue?: number | null;
  currentTitle?: string;
  currentBody?: string;
  currentDraft?: boolean;
};

const ISSUE_FROM_HASH = /(?:^|[^\d])#(\d{1,7})(?:[^\d]|$)/;
const ISSUE_FROM_TOKEN =
  /\b(?:fix(?:es)?|close[sd]?|issue|gh)[\/_-](\d{1,7})\b/i;
const ISSUE_FROM_PREFIX = /^(\d{1,7})[-_/]/;

export function inferLinkedIssueNumber(
  branch: string | null,
  commits: readonly GitLogEntry[],
): number | null {
  const sources = [branch ?? '', ...commits.map((c) => c.subject)];
  for (const source of sources) {
    const hashed = source.match(ISSUE_FROM_HASH);
    if (hashed) return Number(hashed[1]);
    const token = source.match(ISSUE_FROM_TOKEN);
    if (token) return Number(token[1]);
    const prefix = source.match(ISSUE_FROM_PREFIX);
    if (prefix) return Number(prefix[1]);
  }
  return null;
}

function humanizeBranch(branch: string | null): string {
  if (!branch) return 'Update project files';
  const leaf = branch.split('/').pop() ?? branch;
  const cleaned = leaf
    .replace(/^\d+[-_/]/, '')
    .replace(/[-_]+/g, ' ')
    .trim();
  if (!cleaned) return 'Update project files';
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

function stripTrailingPeriod(title: string): string {
  return title.trim().replace(/[.]+$/g, '');
}

/**
 * Rascunho honesto sem LLM: subject do commit mais recente + seções
 * Problem/Solution + `Fixes #N` quando a issue é conhecida.
 */
export function generateLocalPullRequestFields(
  context: PullRequestDraftContext,
): GeneratedPullRequestFields {
  const linkedIssue =
    context.linkedIssue ?? inferLinkedIssueNumber(context.branch, context.commits);
  const head = context.commits[0]?.subject.trim() || humanizeBranch(context.branch);
  const title = stripTrailingPeriod(head).slice(0, 72) || 'Update project files';

  const uniqueSubjects = [
    ...new Set(
      context.commits
        .map((c) => c.subject.trim())
        .filter(Boolean)
        .slice(0, 12),
    ),
  ];
  const solution =
    uniqueSubjects.length > 0
      ? uniqueSubjects.map((s) => `- ${s}`).join('\n')
      : `- Alterações na branch \`${context.branch ?? 'HEAD'}\``;

  const parts = [
    '## Problem',
    title,
    '',
    '## Solution',
    solution,
  ];
  if (linkedIssue) {
    parts.push('', `Fixes #${linkedIssue}`);
  }
  return {
    base: context.base || 'main',
    title,
    body: parts.join('\n'),
    draft: false,
  };
}

function stripJsonFence(raw: string): string {
  let text = raw.trim();
  const fenced = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenced?.[1]) text = fenced[1].trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start !== -1 && end > start) {
    return text.slice(start, end + 1);
  }
  return text;
}

/**
 * Upgrade opcional: se um LLM devolver JSON `{base,title,body,draft}`,
 * parseia; senão cai no fallback local.
 */
export function parseGeneratedPullRequestFields(
  raw: string,
  fallback: Pick<PullRequestDraftContext, 'base'> & {
    currentTitle?: string;
    currentBody?: string;
    currentDraft?: boolean;
  },
): GeneratedPullRequestFields {
  try {
    const parsed = JSON.parse(stripJsonFence(raw)) as unknown;
    if (!parsed || typeof parsed !== 'object') {
      throw new Error('Expected a JSON object.');
    }
    const record = parsed as Record<string, unknown>;
    const base =
      typeof record.base === 'string' && record.base.trim()
        ? record.base.trim()
        : fallback.base;
    const title =
      typeof record.title === 'string' && record.title.trim()
        ? stripTrailingPeriod(record.title)
        : (fallback.currentTitle ?? '').trim();
    const body =
      typeof record.body === 'string'
        ? record.body.replace(/\s+$/g, '')
        : (fallback.currentBody ?? '');
    const draft =
      typeof record.draft === 'boolean'
        ? record.draft
        : (fallback.currentDraft ?? false);
    return {
      base: base || fallback.base || 'main',
      title: title || 'Update project files',
      body,
      draft,
    };
  } catch {
    return {
      base: fallback.base || 'main',
      title: (fallback.currentTitle ?? '').trim() || 'Update project files',
      body: fallback.currentBody ?? '',
      draft: fallback.currentDraft ?? false,
    };
  }
}

export function buildPullRequestFieldsPrompt(
  context: PullRequestDraftContext,
  customPrompt = '',
): string {
  const linked = context.linkedIssue
    ? `Fixes #${context.linkedIssue}`
    : '(none)';
  const commits =
    context.commits
      .map((c) => `${c.hash.slice(0, 7)} ${c.subject}`)
      .join('\n') || '(none)';
  const base = [
    'You are generating pull request details.',
    'Return ONLY compact JSON with this exact shape:',
    '{"base":"branch-name","title":"short title","body":"markdown description","draft":false}',
    '',
    'Rules:',
    '- Title: concise, specific, no trailing period.',
    '- Body: start with `## Problem`, then `## Solution`.',
    context.linkedIssue
      ? `- Mention the linked issue with \`Fixes #${context.linkedIssue}\` only for a complete fix.`
      : '- No issue is linked; do not invent one.',
    '',
    `Head branch: ${context.branch ?? '(detached)'}`,
    `Current base: ${context.base}`,
    `Linked issue: ${linked}`,
    '',
    'Commits:',
    commits,
  ].join('\n');
  const extra = customPrompt.trim();
  if (!extra) {
    return `${base}\n\nFinal output requirement:\nReturn compact JSON only with keys base, title, body, and draft.`;
  }
  return `${base}\n\nAdditional user prompt:\n${extra.slice(0, 4_000)}\n\nFinal output requirement:\nReturn compact JSON only with keys base, title, body, and draft.`;
}
