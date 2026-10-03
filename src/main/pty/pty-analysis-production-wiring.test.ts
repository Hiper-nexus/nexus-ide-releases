import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
const source = (relative: string) => fs.readFileSync(path.join(process.cwd(), 'src/main', relative), 'utf8');
describe('production analysis ownership', () => {
  it('registers typed worker consumers instead of duplicate Main text scans', () => {
    for (const [file, consumer] of [
      ['detect/detector.ts', 'screen'], ['orch/failover.ts', 'failover'],
      ['orch/pane-registry.ts', 'dev-server'], ['orch/token-speed-tracker.ts', 'token'],
      ['orch/mcp-server.ts', 'handoff'], ['orch/mcp-server.ts', 'mission-control'],
      ['orch/pane-pipe.ts', 'pipe'], ['terminal/command-block-tracker.ts', 'command'],
    ]) expect(source(file)).toContain(`subscribePtyAnalysis('${consumer}'`);
    for (const file of ['detect/detector.ts', 'orch/failover.ts', 'orch/token-speed-tracker.ts', 'orch/mcp-server.ts', 'orch/pane-pipe.ts']) {
      const body = source(file);
      expect(body).not.toMatch(/\btapSessionData\s*\(/);
      expect(body).not.toMatch(/\b(?:evaluateManifest|detectLimit|stripAnsi)\s*\(/);
    }
    expect(source('orch/paste-ingest.ts')).toContain("watchPtyAnalysisSession('paste'");
  });
  it('has a separate worker entry and leaves physical controls in the host', () => {
    expect(source('pty/pty-analysis-runtime.ts')).toContain("new Worker(path.join(__dirname, 'pty-analysis-worker-entry.js')");
    const core = source('pty/pty-analysis-core.ts');
    expect(core).not.toMatch(/from\s+['"].*(?:pty-manager|pane-registry|account-store|settings-store|electron)/);
    expect(source('pty/pty-host-entry.ts')).toContain("case 'analysis-credit'");
    expect(source('pty/pty-host-entry.ts')).toContain("case 'terminate'");
  });
});
