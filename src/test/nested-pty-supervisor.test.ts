import { describe, expect, it } from 'vitest';
import { nestedPtySupervisorEvidence, parseProcessTable } from './nested-pty-supervisor';

const SUPERVISOR = '/Applications/NexusIDE.app/Contents/Resources/nexus-pty-supervisor';
// Árvore real de um pane (ps -axo pid=,ppid=,comm=), com o vitest admitido pela fila heavy.
const paneTable = parseProcessTable([
  '    1     0 /sbin/launchd',
  '39420     1 /Applications/NexusIDE.app/Contents/MacOS/nexus-ide',
  '39525 39420 /Applications/NexusIDE.app/Contents/Frameworks/NexusIDE Helper.app/Contents/MacOS/NexusIDE Helper',
  `45602 39525 ${SUPERVISOR}`,
  '45603 45602 /Users/op/.local/bin/claude',
  '50000 45603 /bin/zsh',
  '50001 50000 /opt/homebrew/opt/node@22/bin/node',
  '50002 50001 /opt/homebrew/opt/node@22/bin/node',
].join('\n'));
// Mesma árvore vista de um job launchd: launchd → bash → node.
const launchdTable = parseProcessTable([
  '    1     0 /sbin/launchd',
  `45602 39525 ${SUPERVISOR}`,
  '60000     1 /bin/bash',
  '60001 60000 /opt/homebrew/opt/node@22/bin/node',
  '60002 60001 /opt/homebrew/opt/node@22/bin/node',
].join('\n'));

describe('F-1217 — suíte sob um nexus-pty-supervisor', () => {
  it('lê a tabela do ps com espaços no caminho do executável', () => {
    expect(paneTable.find((row) => row.pid === 39525)).toEqual({ pid: 39525, ppid: 39420, command: '/Applications/NexusIDE.app/Contents/Frameworks/NexusIDE Helper.app/Contents/MacOS/NexusIDE Helper' });
  });

  it('acusa o supervisor ancestral, mesmo sem a env do pane (terminal humano, env -i)', () => {
    expect(nestedPtySupervisorEvidence({ platform: 'darwin', pid: 50002, env: {}, processes: paneTable }))
      .toBe('ancestral pid 45602 é nexus-pty-supervisor');
  });

  it('acusa a env do pane quando a árvore não mostra o supervisor (filho reparentado ou ps negado)', () => {
    expect(nestedPtySupervisorEvidence({ platform: 'darwin', pid: 60002, env: { NEXUS_PANE_KEY: 'pty-1' }, processes: launchdTable }))
      .toBe('NEXUS_PANE_KEY herdado de um pane do Nexus');
    expect(nestedPtySupervisorEvidence({ platform: 'darwin', pid: 1234, env: { NEXUS_PANE_ID: 'pane-1' }, processes: null }))
      .toBe('NEXUS_PANE_ID herdado de um pane do Nexus');
  });

  it('não pula no launchd, no CI nem fora do macOS', () => {
    expect(nestedPtySupervisorEvidence({ platform: 'darwin', pid: 60002, env: {}, processes: launchdTable })).toBeUndefined();
    expect(nestedPtySupervisorEvidence({ platform: 'darwin', pid: 60002, env: { NEXUS_PANE_KEY: ' ' }, processes: launchdTable })).toBeUndefined();
    expect(nestedPtySupervisorEvidence({ platform: 'linux', pid: 50002, env: { NEXUS_PANE_KEY: 'pty-1' }, processes: paneTable })).toBeUndefined();
  });
});
