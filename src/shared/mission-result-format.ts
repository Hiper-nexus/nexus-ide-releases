/**
 * Main-owned boundary between the current fan-out report and older mission
 * memory. The final report always precedes this marker and is never shortened
 * to make room for history.
 */
export const PRIOR_MISSION_MEMORY_MARKER =
  '<!-- nexus:prior-mission-memory:v1 -->\n## Memória anterior da missão';

export const PRIOR_MISSION_MEMORY_SEPARATOR =
  `\n\n${PRIOR_MISSION_MEMORY_MARKER}\n`;
