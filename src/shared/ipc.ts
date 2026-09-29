import path from 'node:path';
import { z } from 'zod';
import type { LayoutNode, WorkspaceLayout } from './types';

/**
 * Zod schemas validating every IPC payload the main process accepts. These run
 * at the trust boundary: the renderer is treated as untrusted input, so nothing
 * reaches the PTY layer or the filesystem without passing validation here.
 */

const DIMENSION = z.number().int().positive().max(2000);

export const spawnRequestSchema = z.object({
  cwd: z.string().min(1).max(4096).optional(),
  worktreeSpaceId: z.string().regex(/^space-[a-z0-9-]{1,120}$/).optional(),
  // A caller-supplied shell must be an absolute path — never a bare command name
  // resolved against PATH — so the renderer cannot coax the main process into
  // launching an arbitrary binary off the search path.
  shell: z
    .string()
    .min(1)
    .max(4096)
    .refine((value) => path.isAbsolute(value), {
      message: 'shell must be an absolute path',
    })
    .optional(),
  cols: DIMENSION,
  rows: DIMENSION,
  kind: z.enum(['shell', 'cli-agent']),
  // cli-agent only: the renderer supplies an adapterId and optional model;
  // the main process looks up the full adapter config (including auth) locally.
  adapterId: z.string().min(1).max(64).optional(),
  model: z.string().min(1).max(128).optional(),
  accountId: z.string().min(1).max(128).optional(),
  // Correlates an orchestration-requested spawn (MCP pane_spawn) with its
  // pending skill-gate context. Opaque to the renderer.
  orchRequestId: z.string().min(1).max(128).optional(),
  missionId: z.string().min(1).max(128).optional(),
  // Re-spawn continuing the previous session (failover switches accounts and
  // re-launches the CLI with its resumeArgs).
  resume: z.boolean().optional(),
  resumeLatestOnly: z.boolean().optional(),
  restorePersistedAuthority: z.boolean().optional(),
  paneId: z.string().max(64).optional(),
  // Per-spawn reasoning effort (task-router decision). Validated against the
  // adapter's declared levels at arg-build time; unknown values are dropped.
  effort: z.string().min(1).max(32).optional(),
  // F-213: telemetria — quanto o renderer esperou (grade + conta + fila)
  // antes de chamar pty.spawn. Telemetria NUNCA pode reprovar um spawn:
  // qualquer valor inválido cai para undefined e o main só registra
  // números finitos (clampados/arredondados) — sem teto no schema.
  rendererWaitMs: z.number().nonnegative().optional().catch(undefined),
});

export const writeSchema = z.object({
  sessionId: z.string().min(1).max(128),
  data: z.string().max(1_000_000),
});

export const resizeSchema = z.object({
  sessionId: z.string().min(1).max(128),
  cols: DIMENSION,
  rows: DIMENSION,
});

export const killSchema = z.object({
  sessionId: z.string().min(1).max(128),
});

export const ptyAcknowledgeSchema = z.object({
  sessionId: z.string().min(1).max(128),
  sequence: z.number().int().nonnegative(),
});

export const ptyRecoverSchema = z.object({
  sessionId: z.string().min(1).max(128),
  afterSequence: z.number().int().nonnegative(),
});

const paneModelSchema = z.object({
  id: z.string().min(1).max(128),
  kind: z.enum(['shell', 'cli-agent', 'browser']),
  title: z.string().max(512),
  /**
   * Número humano do pane. É ESTE campo que faz o número sobreviver ao
   * restart: `z.object` descarta chave desconhecida em silêncio, então sem a
   * entrada aqui o layout gravado voltaria do disco sem número e todo restart
   * renumeraria os panes do zero — o operador perderia justamente a memória
   * ("o pane 7 é o do build") que o número existe para criar.
   */
  paneNumber: z.number().int().positive().max(999_999).optional(),
  isStructuralPlaceholder: z.literal(true).optional(),
  cwd: z.string().max(4096).optional(),
  browserUrl: z.string().max(4096).optional(),
  browserOpenRequestId: z.string().min(1).max(128).optional(),
  adapterId: z.string().min(1).max(64).optional(),
  model: z.string().min(1).max(128).optional(),
  accountId: z.string().min(1).max(128).optional(),
  role: z.enum(['orchestrator', 'worker']).optional(),
  agentName: z.string().min(1).max(256).optional(),
  effort: z.string().min(1).max(32).optional(),
  titlePinned: z.boolean().optional(),
  orchRequestId: z.string().min(1).max(128).optional(),
  missionId: z.string().min(1).max(128).optional(),
  /**
   * Espaço do operador. Mesma razão do `paneNumber` acima: `z.object` descarta
   * chave desconhecida em SILÊNCIO, então sem estas duas entradas o layout
   * voltaria do disco sem escopo e todo restart remisturaria os painéis de
   * espaços diferentes num mosaico só.
   */
  spaceId: z.string().min(1).max(128).optional(),
  isolateSpace: z.literal(true).optional(),
  spaceTitle: z.string().min(1).max(256).optional(),
  /** Mesma razão: sem a entrada, a missão hospedada voltaria à aba própria no restart. */
  missionHost: z.literal(true).optional(),
  transient: z.literal(true).optional(),
  terminalScrollback: z.string().max(256_000).optional(),
  /**
   * Largura (colunas) em que o scrollback acima foi capturado. Uma TUI desenha
   * caixas com cursor absoluto: reescrever essa fita numa grade mais estreita
   * entrelaça moldura e texto, e reflow não desfaz. Sem esse número não há como
   * saber se o replay é seguro.
   */
  terminalScrollbackCols: z.number().int().positive().max(2_000).optional(),
});

// Recursive layout tree schema (leaf | split with two children).
export const layoutNodeSchema: z.ZodType<LayoutNode> = z.lazy(() =>
  z.union([
    z.object({
      kind: z.literal('leaf'),
      id: z.string().min(1).max(128),
      pane: paneModelSchema,
    }),
    z.object({
      kind: z.literal('split'),
      id: z.string().min(1).max(128),
      direction: z.enum(['row', 'column']),
      children: z.tuple([layoutNodeSchema, layoutNodeSchema]),
    }),
  ]),
);

// finite() rejects NaN/±Infinity — a non-finite viewport or node geometry
// crashes the canvas renderer on restore (the class of bug Maestri hit at
// 0.30.8/0.30.13). Guarding at the persistence boundary keeps a corrupt value
// from ever reaching the layout tree.
const canvasNodeLayoutSchema = z.object({
  position: z.object({ x: z.number().finite(), y: z.number().finite() }),
  size: z.object({
    width: z.number().finite().positive().max(100_000),
    height: z.number().finite().positive().max(100_000),
  }),
  z: z.number().int(),
});

const canvasViewportSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  zoom: z.number().finite().positive().max(1000),
});

export const workspaceLayoutSchema: z.ZodType<WorkspaceLayout> = z.object({
  root: layoutNodeSchema,
  focusedPaneId: z.string().min(1).max(128).nullable(),
  viewKind: z.enum(['grid', 'canvas']).optional(),
  canvasNodeLayouts: z.record(z.string(), canvasNodeLayoutSchema).optional(),
  canvasViewport: canvasViewportSchema.optional(),
});
