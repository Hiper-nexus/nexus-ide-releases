/**
 * Soft/hard caps for live panes, shared by the renderer layout (refusal
 * point) and the main-process scheduler (pane budget input). Above soft, new
 * orch spawns are refused so a stalled mission cannot flood a small screen;
 * hard is a hard stop for any path.
 *
 * Soft = 16 fits the frictionless default wave: orchestrator + 8 workers +
 * operator panes. Keep the scheduler's pane budget (`paneBudget` in
 * mission-scheduler-production) derived from this value.
 */
export const MAX_LIVE_PANES_SOFT = 16;
export const MAX_LIVE_PANES_HARD = 20;
