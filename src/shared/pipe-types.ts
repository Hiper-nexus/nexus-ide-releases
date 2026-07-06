import { z } from 'zod';

/**
 * Pane pipes — "edges que conversam". A pipe connects the OUTPUT of a source
 * pane to the INPUT of a target pane: whatever the source agent prints is
 * typed into the target agent's terminal (Maestri-style agent-to-agent
 * conversation over PTYs). Panes are addressed by paneId (stable across
 * re-spawns); sessionIds are resolved at forwarding time.
 */

export const pipeModeSchema = z.enum(['stream', 'onIdle']);
export type PipeMode = z.infer<typeof pipeModeSchema>;

export interface Pipe {
  id: string;
  sourcePaneId: string;
  targetPaneId: string;
  /**
   * stream — forward every complete output line as it appears.
   * onIdle — wait for the source to go idle, then forward its last response
   *          as a single injected message.
   */
  mode: PipeMode;
  /** Number of messages successfully forwarded through this pipe (UI badge). */
  deliveryCount?: number;
}

export const pipeSchema = z.object({
  id: z.string().min(1).max(128),
  sourcePaneId: z.string().min(1).max(128),
  targetPaneId: z.string().min(1).max(128),
  mode: pipeModeSchema,
  deliveryCount: z.number().int().min(0).optional(),
});

export const addPipeSchema = z.object({
  sourcePaneId: z.string().min(1).max(128),
  targetPaneId: z.string().min(1).max(128),
  mode: pipeModeSchema,
});
export type AddPipeRequest = z.infer<typeof addPipeSchema>;

export const pipeIdSchema = z.object({ id: z.string().min(1).max(128) });

export const PIPE_CHANNELS = {
  list: 'pipes:list',
  add: 'pipes:add',
  remove: 'pipes:remove',
  changed: 'pipes:changed',
} as const;

export interface AddPipeResult {
  ok: boolean;
  id?: string;
  error?: string;
}

/**
 * Renderer-facing pipe API, exposed by the preload as `window.nexus.pipes`.
 * Ready to paste into NexusApi in shared/types.ts as `pipes: PipeApi`.
 */
export interface PipeApi {
  list(): Promise<Pipe[]>;
  add(
    sourcePaneId: string,
    targetPaneId: string,
    mode: PipeMode,
  ): Promise<AddPipeResult>;
  remove(id: string): Promise<{ ok: boolean }>;
  onChanged(cb: (pipes: Pipe[]) => void): () => void;
}
