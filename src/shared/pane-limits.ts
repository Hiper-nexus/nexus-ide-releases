/**
 * Soft/hard caps for live panes, shared by the renderer layout (refusal
 * point) and the main-process scheduler (pane budget input). Above soft, new
 * orch spawns are refused so a stalled mission cannot flood a small screen;
 * hard is a hard stop for any path.
 *
 * Modo livre de operação: soft duplicado para 32 panes, hard 40, dando
 * margem para grandes waves sem travar o grid.
 */
export const MAX_LIVE_PANES_SOFT = 32;
export const MAX_LIVE_PANES_HARD = 40;
