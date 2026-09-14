import * as nodePty from '@lydell/node-pty';
import { stripTerminalControlSequences } from '../src/shared/terminal-control-sequences';

const EXPECTED_VERSION = 'codex-cli 0.145.0';
const MAX_OUTPUT_CHARS = 4_096;

const executable = process.env.NEXUS_SMOKE_CODEX_EXE;
if (!executable) throw new Error('NEXUS_SMOKE_CODEX_EXE is required');

let output = '';
const terminal = nodePty.spawn(executable, ['--version'], {
  name: 'xterm-256color',
  cols: 80,
  rows: 24,
  cwd: process.cwd(),
  env: process.env as Record<string, string>,
});

terminal.onData((data) => {
  if (output.length < MAX_OUTPUT_CHARS) output += data;
});
terminal.onExit(({ exitCode, signal }) => {
  const normalized = stripTerminalControlSequences(output).trim();
  if (exitCode !== 0 || signal || normalized !== EXPECTED_VERSION) {
    process.stderr.write(
      `${JSON.stringify({ exitCode, signal, output: normalized })}\n`,
      () => process.exit(1),
    );
    return;
  }
  process.stdout.write(
    `[windows-smoke] native Codex node-pty proof: ${normalized}\n`,
    () => process.exit(0),
  );
});
