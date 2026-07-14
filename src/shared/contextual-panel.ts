import { z } from 'zod';

/**
 * Unified contextual right panel tabs (flag feature.ui.contextualPanel).
 */

export const CONTEXTUAL_TABS = [
  'browser',
  'editor',
  'git',
  'skills',
  'memory',
  'mission',
  'handoff',
  'search',
] as const;

export type ContextualTab = (typeof CONTEXTUAL_TABS)[number];

export const contextualPanelStateSchema = z
  .object({
    visible: z.boolean().default(true),
    activeTab: z.enum(CONTEXTUAL_TABS).default('editor'),
    widthPx: z.number().int().min(200).max(900).default(360),
    /** Per-workspace tab persistence key = workspace id */
    workspaceId: z.string().min(1).max(128).optional(),
  })
  .strict();

export type ContextualPanelState = z.infer<typeof contextualPanelStateSchema>;

export const DEFAULT_CONTEXTUAL_PANEL: ContextualPanelState =
  contextualPanelStateSchema.parse({});

/** Opening a tab never grants permissions — label for empty/loading copy. */
export const CONTEXTUAL_TAB_COPY: Record<
  ContextualTab,
  { title: string; empty: string; loading: string }
> = {
  browser: {
    title: 'Browser',
    empty: 'No page open. Navigation uses the workspace allowlist.',
    loading: 'Loading page…',
  },
  editor: {
    title: 'Editor',
    empty: 'Select a file. Paths stay inside the authorized workspace.',
    loading: 'Opening file…',
  },
  git: {
    title: 'Git',
    empty: 'No repository status yet.',
    loading: 'Reading git status…',
  },
  skills: {
    title: 'Skills',
    empty: 'No skills in catalog. Import or create under project skills.',
    loading: 'Loading skills…',
  },
  memory: {
    title: 'Memory',
    empty: 'No memory notes yet. Capture decisions under .nexus-memory/.',
    loading: 'Loading memory…',
  },
  mission: {
    title: 'Mission',
    empty: 'No active mission in this workspace.',
    loading: 'Loading mission…',
  },
  handoff: {
    title: 'Handoff',
    empty: 'No handoffs yet.',
    loading: 'Loading handoffs…',
  },
  search: {
    title: 'Search',
    empty: 'Search files, missions, commands, skills…',
    loading: 'Searching…',
  },
};
