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

  it('F-1324: decodifica caminhos C-quoted do Git em modificação e exclusão', () => {
    const diff = [
      'diff --git "a/caf\\303\\251.ts" "b/caf\\303\\251.ts"',
      '--- "a/caf\\303\\251.ts"',
      '+++ "b/caf\\303\\251.ts"',
      '@@ -1 +1 @@',
      '-old',
      '+new',
      'diff --git "a/caf\\303\\251-old.ts" "b/caf\\303\\251-old.ts"',
      '--- "a/caf\\303\\251-old.ts"',
      '+++ /dev/null',
      '@@ -1 +0,0 @@',
      '-gone',
      'diff --git "a/espa\\347o com tab\\tnome.ts" "b/espa\\347o com tab\\tnome.ts"',
      '--- "a/espa\\347o com tab\\tnome.ts"',
      '+++ "b/espa\\347o com tab\\tnome.ts"',
      '@@ -1 +1 @@',
      '-a',
      '+b',
      '',
    ].join('\n');

    const hunks = parseUnifiedDiff(diff);
    expect(hunks[0]?.file).toBe('café.ts');
    expect(hunks[1]?.file).toBe('café-old.ts');
    expect(hunks[2]?.file).toBe('espaço com tab\tnome.ts');

    const attributed = attributeHunks(hunks, [
      { agentId: 'writer-1', paths: ['café-old.ts'], at: 100 },
    ]);
    expect(attributed[1]?.source).toBe('agent');
    expect(attributed[1]?.agentId).toBe('writer-1');
  });
});
