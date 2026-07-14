import { z } from 'zod';

/**
 * Progressive onboarding + launcher contracts (BridgeSpace-inspired, clean-room).
 * Feature-flagged via feature.ui.progressiveOnboarding.
 */

export const WORK_MODES = [
  'terminal-only',
  'missions',
  'swarm',
  'board',
  'memory',
  'skills',
] as const;
export type WorkMode = (typeof WORK_MODES)[number];

export const LAYOUT_PANE_COUNTS = [1, 2, 4, 6, 8, 10, 12] as const;
export type LayoutPaneCount = (typeof LAYOUT_PANE_COUNTS)[number];

export const AGENT_DISTRIBUTION = [
  'none',
  'enable-all',
  'one-of-each',
  'split-evenly',
] as const;
export type AgentDistribution = (typeof AGENT_DISTRIBUTION)[number];

export const progressiveLaunchSchema = z
  .object({
    mode: z.enum(WORK_MODES).default('terminal-only'),
    paneCount: z
      .number()
      .int()
      .refine((n): n is LayoutPaneCount =>
        (LAYOUT_PANE_COUNTS as readonly number[]).includes(n),
      )
      .default(1),
    agentDistribution: z.enum(AGENT_DISTRIBUTION).default('none'),
    openWithoutAi: z.boolean().default(true),
    presetName: z.string().max(128).optional(),
    recentWorkspacePath: z.string().max(4096).optional(),
  })
  .strict();

export type ProgressiveLaunch = z.infer<typeof progressiveLaunchSchema>;

export const LAUNCHER_MODES = [
  { id: 'terminal' as const, label: 'Terminal', description: 'Open shell panes without AI' },
  { id: 'missions' as const, label: 'Missions', description: 'Mission-driven work' },
  { id: 'swarm' as const, label: 'Swarm', description: 'Multi-agent fleet' },
  { id: 'board' as const, label: 'Board', description: 'Ops / kanban board' },
  { id: 'memory' as const, label: 'Memory', description: 'Local project memory' },
  { id: 'skills' as const, label: 'Skills', description: 'Skills catalog' },
];

export function previewLaunchSummary(plan: ProgressiveLaunch): string {
  const parts = [
    plan.openWithoutAi ? 'without AI' : 'with agents',
    `${plan.paneCount} pane(s)`,
    `mode=${plan.mode}`,
    `agents=${plan.agentDistribution}`,
  ];
  if (plan.presetName) parts.push(`preset=${plan.presetName}`);
  if (plan.recentWorkspacePath) parts.push('recent workspace');
  return parts.join(' · ');
}
