import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// F-1274: drives the real bash/zsh interpreters through the Nexus OSC 133
// integration scripts and inspects the sequences they actually emit, instead
// of re-parsing the script text. Skipped when the shell is not on PATH.
const SCRIPT_DIR = path.resolve(__dirname, '../../../resources/shell-integration');
const OSC = /\x1b\]133;([A-Z])(?:;([^\x07]*))?\x07/g;

const hasShell = (name: string) => {
  try {
    execFileSync(name, ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};

interface Emitted {
  marks: string[];
  /** (mark, payload) pairs for E and D sequences, in emission order. */
  events: Array<[string, string]>;
}

const driveShell = (shell: string, prelude: string[], commands: string[]): Emitted => {
  const script = [...prelude, ...commands, 'exit 0\n'].join('\n');
  // bash --norc skips rcs; the zsh equivalent is -f (NO_RCS).
  const args = shell === 'zsh' ? ['-f', '-i'] : ['--norc', '-i'];
  const output = execFileSync(shell, args, {
    input: script,
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '', TERM: 'dumb', HOME: process.env.HOME ?? '' },
  });
  const marks: string[] = [];
  const events: Array<[string, string]> = [];
  for (const match of output.matchAll(OSC)) {
    marks.push(match[1]);
    if (match[1] === 'E' || match[1] === 'D') events.push([match[1], match[2] ?? '']);
  }
  return { marks, events };
};

describe('bash OSC 133 integration emits a clean lifecycle', () => {
  it.skipIf(!hasShell('bash'))('does not emit markers for PROMPT_COMMAND itself', () => {
    const emitted = driveShell('bash', [`source '${SCRIPT_DIR}/nexus-osc133.bash'`], [
      'echo hi',
      'false',
    ]);
    // The hook's own name must never travel as a 133;E command line.
    expect(emitted.events.filter(([mark, arg]) => mark === 'E' && arg.includes('__nexus_prompt_command'))).toEqual([]);
    // Every E names a real user command, in order ('exit 0' is the harness's
    // own last line).
    expect(emitted.events.filter(([mark]) => mark === 'E').map(([, arg]) => arg)).toEqual(['echo hi', 'false', 'exit 0']);
    // Each command's D carries that command's own exit status.
    const codes = emitted.events.filter(([mark]) => mark === 'D').map(([, arg]) => arg);
    expect(codes.slice(-2)).toEqual(['0', '1']);
  });
});

describe('zsh OSC 133 integration reads the command exit status first', () => {
  it.skipIf(!hasShell('zsh'))('133;D carries the command status even with an earlier precmd hook', () => {
    // Simulates the operator's .zshrc: another precmd hook (starship/p10k)
    // is installed BEFORE the Nexus integration is sourced, so with
    // add-zsh-hook the Nexus precmd runs last and reads the other hook's $?.
    const emitted = driveShell('zsh', [
      '_nexus_mock_precmd() { return 0; }',
      'precmd_functions+=(_nexus_mock_precmd)',
      `source '${SCRIPT_DIR}/nexus-osc133.zsh'`,
    ], ['false']);
    const lastD = [...emitted.events].reverse().find(([mark]) => mark === 'D')?.[1];
    expect(lastD).toBe('1');
  });
});
