/**
 * Stable markers for the multi-account failover continuity pack.
 *
 * The pack is Nexus's own text, injected into the replacement pane's PTY after
 * a cross-account switch. It quotes the prior limit reason and a scrollback
 * excerpt of the previous terminal — both carry verbatim provider error phrases.
 * The failover limit-detector taps that same PTY, so it MUST recognise and skip
 * this self-authored block; otherwise it re-fires on every replacement account,
 * cascading the whole fleet into cooldown (the phantom-limit loop).
 *
 * Shared between the renderer builder (`failover-continuity.ts`) and the main
 * detector (`limit-detector.ts`) so the two never drift apart.
 */

/** First line of every continuity pack. */
export const FAILOVER_HANDOFF_HEADER = '[NEXUS FAILOVER HANDOFF]';

/** Last line of every continuity pack. */
export const FAILOVER_HANDOFF_FOOTER = 'Execute the next concrete step now.';
