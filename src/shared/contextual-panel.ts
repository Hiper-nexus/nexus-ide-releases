import { z } from 'zod';

/**
 * Unified contextual right panel tabs (flag feature.ui.contextualPanel).
 */

export const CONTEXTUAL_TABS = [
  'browser',
  'editor',
  'git',
  'skills',
  'marketplace',
  'memory',
  'mission',
  'handoff',
  'search',
] as const;

export type ContextualTab = (typeof CONTEXTUAL_TABS)[number];

export const contextualPanelStateSchema = z
  .object({
    // Canvas-first: context opens when requested (file, Git, handoff, search)
    // instead of permanently shrinking every terminal on first use.
    visible: z.boolean().default(false),
    activeTab: z.enum(CONTEXTUAL_TABS).default('mission'),
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
    empty: 'Nenhuma página aberta. A navegação usa a allowlist do workspace.',
    loading: 'Carregando página…',
  },
  editor: {
    title: 'Editor',
    empty: 'Selecione um arquivo. Os caminhos ficam dentro do workspace autorizado.',
    loading: 'Abrindo arquivo…',
  },
  git: {
    title: 'Git',
    empty: 'Sem status do repositório ainda. Abra um workspace com git.',
    loading: 'Lendo git status…',
  },
  skills: {
    title: 'Skills',
    empty: 'Nenhuma skill no catálogo. Importe ou crie em skills do projeto.',
    loading: 'Carregando skills…',
  },
  marketplace: {
    title: 'Marketplace',
    empty: 'Catálogo de agents e skills. Instale em 1 clique.',
    loading: 'Carregando catálogo…',
  },
  memory: {
    title: 'Memória',
    empty: 'Sem notas de memória. Capture decisões em .nexus-memory/.',
    loading: 'Carregando memória…',
  },
  mission: {
    title: 'Missão',
    empty: 'Nenhuma missão ativa neste workspace.',
    loading: 'Carregando missão…',
  },
  handoff: {
    title: 'Handoff',
    empty: 'Nenhum handoff ainda.',
    loading: 'Carregando handoffs…',
  },
  search: {
    title: 'Busca',
    empty: 'Busque arquivos, missões, comandos, skills…',
    loading: 'Buscando…',
  },
};
