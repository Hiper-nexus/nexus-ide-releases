/**
 * Soft/hard caps for live panes, shared by the renderer layout (refusal
 * point) and the main-process scheduler (pane budget input). Above soft, new
 * orch spawns are refused so a stalled mission cannot flood a small screen;
 * hard is a hard stop for any path.
 *
 * Modo livre de operação: soft 80 panes, hard 100, dando margem para
 * as 64 cadeiras de worker sem travar o grid prematuramente.
 */
export const MAX_LIVE_PANES_SOFT = 80;
export const MAX_LIVE_PANES_HARD = 100;
