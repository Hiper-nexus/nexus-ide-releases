import { describe, expect, it } from 'vitest';
import {
  attributeHunks,
  parseUnifiedDiff,
  summarizeAttribution,
} from '../../shared/hunk-tracker';

const SAMPLE = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,4 @@
 line1
+agent line
 line2
 line3
diff --git a/src/b.ts b/src/b.ts
--- a/src/b.ts
+++ b/src/b.ts
@@ -1,2 +1,2 @@
-old
+user change
`;

describe('hunk-tracker', () => {
  it('parses unified diff into per-file hunks', () => {
    const hunks = parseUnifiedDiff(SAMPLE);
    expect(hunks.length).toBe(2);
    expect(hunks[0]?.file).toBe('src/a.ts');
    expect(hunks[1]?.file).toBe('src/b.ts');
    expect(hunks[0]?.body).toContain('+agent line');
  });

  it('attributes paths claimed by agents', () => {
    const hunks = parseUnifiedDiff(SAMPLE);
    const attributed = attributeHunks(hunks, [
      {
        agentId: 'grok-reviewer',
        adapterId: 'grok',
        paths: ['src/a.ts'],
        at: 100,
      },
    ], { userTouchedPaths: new Set(['src/b.ts']) });
    expect(attributed[0]?.source).toBe('agent');
    expect(attributed[0]?.agentId).toBe('grok-reviewer');
    expect(attributed[1]?.source).toBe('user');
    expect(summarizeAttribution(attributed).agent).toBe(1);
    expect(summarizeAttribution(attributed).user).toBe(1);
  });
});
