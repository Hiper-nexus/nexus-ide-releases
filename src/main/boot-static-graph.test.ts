import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (relative: string) =>
  fs.readFileSync(new URL(relative, import.meta.url), 'utf8');

describe('boot static graph', () => {
  it('keeps voice, eval and the MCP toolset off the static main import graph', () => {
    const main = read('./main.ts');
    const mcp = read('./orch/mcp-server.ts');
    const voice = read('./voice/live-tool-dispatch.ts');
    const ipc = read('./jarvis/mcp-ipc.ts');
    expect(main).not.toMatch(/from ['"]\.\/voice\/voice-ipc['"]/);
    expect(main).not.toMatch(/from ['"]\.\/eval\/eval-ipc['"]/);
    expect(main).toContain("await import('./voice/voice-ipc')");
    expect(main).toContain("await import('./eval/eval-ipc')");
    expect(main).toContain("await bootStepAsync('registerVoiceIpc'");
    expect(main).toContain("await bootStepAsync('registerEvalRankingIpc'");
    expect(main).toMatch(/traceBootstrap\('before voice IPC'\);/);
    expect(main).toMatch(/traceBootstrap\('after voice IPC'\);/);
    expect(main).toContain('registerQuotaServiceLazy(() => ({');
    for (const source of [mcp, voice, ipc]) {
      expect(source).not.toMatch(/from ['"][^'"]*\/tools['"]/);
      expect(source).toContain('loadToolset');
    }
  });

  it('loads mechanical sensors only at the review call, not as a static import', () => {
    const review = read('./orch/civilian-auto-review.ts');
    const completion = read('./orch/completion-check-executors.ts');
    expect(review).not.toMatch(/^\s*import\s*\{[^}]*\}\s*from ['"]\.\.\/context\/mechanical-sensors['"]/m);
    expect(review).toContain("await import('../context/mechanical-sensors')");
    expect(completion).not.toMatch(/^\s*import\s*\{[^}]*runTypecheckSensor/m);
    expect(completion).toContain("await import('../context/mechanical-sensors')");
  });
});
