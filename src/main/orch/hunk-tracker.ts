/**
 * Main re-export — pure logic lives in shared so DiffAnnotate (renderer)
 * and MCP tools share one implementation.
 */
export {
  parseUnifiedDiff,
  attributeHunks,
  summarizeAttribution,
  type HunkSource,
  type DiffHunk,
  type AttributedHunk,
  type AgentTouch,
} from '../../shared/hunk-tracker';
