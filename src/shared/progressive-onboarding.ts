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
    mode: z.enum(WORK_MODES).default('missions'),
    paneCount: z
      .number()
      .int()
      .refine((n): n is LayoutPaneCount =>
        (LAYOUT_PANE_COUNTS as readonly number[]).includes(n),
      )
      .default(1),
    agentDistribution: z.enum(AGENT_DISTRIBUTION).default('one-of-each'),
    openWithoutAi: z.boolean().default(false),
    presetName: z.string().max(128).optional(),
    recentWorkspacePath: z.string().max(4096).optional(),
  })
  .strict();

export type ProgressiveLaunch = z.infer<typeof progressiveLaunchSchema>;

export const LAUNCHER_MODES = [
  {
    id: 'terminal' as const,
    label: 'Terminal',
    description: 'Abrir panes de shell sem IA',
  },
  {
    id: 'missions' as const,
    label: 'Missões',
    description: 'Trabalho guiado por missão',
  },
  {
    id: 'swarm' as const,
    label: 'Enxame',
    description: 'Frota multi-agente',
  },
  {
    id: 'board' as const,
    label: 'Board',
    description: 'Ops / quadro kanban',
  },
  {
    id: 'memory' as const,
    label: 'Memória',
    description: 'Memória local do projeto',
  },
  {
    id: 'skills' as const,
    label: 'Skills',
    description: 'Catálogo de skills',
  },
  {
    id: 'marketplace' as const,
    label: 'Marketplace',
    description: 'Catálogo de agents e skills — instalar em 1 clique',
  },
];

export function previewLaunchSummary(plan: ProgressiveLaunch): string {
  const parts = [
    plan.openWithoutAi ? 'sem IA' : 'com agentes',
    `${plan.paneCount} pane(s)`,
    `modo=${plan.mode}`,
    `agentes=${plan.agentDistribution}`,
  ];
  if (plan.presetName) parts.push(`preset=${plan.presetName}`);
  if (plan.recentWorkspacePath) parts.push('workspace recente');
  return parts.join(' · ');
}
