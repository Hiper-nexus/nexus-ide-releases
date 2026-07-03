import { describe, expect, it } from 'vitest';
import { stripPromptEcho } from './response-echo';

describe('stripPromptEcho', () => {
  it('drops the echoed prompt and keeps only the agent response', () => {
    const prompt = 'run the tests';
    // PTY buffer: the pane echoes the command, then the agent replies.
    const buffer = 'run the tests\r\nAll 88 tests passed in 2.1 seconds.';
    const out = stripPromptEcho(buffer, prompt);
    expect(out).toBe('All 88 tests passed in 2.1 seconds.');
    expect(out).not.toContain('run the tests');
  });

  it('strips ANSI and matches the prompt across interleaved spinner frames', () => {
    const prompt = 'summarize the build';
    // A TUI weaves color codes and a cursor move between the echoed words.
    const buffer =
      '\x1b[2m> \x1b[0msummarize \x1b[36mthe\x1b[0m build\r\n' +
      '\x1b[1mThe build succeeded with no warnings.\x1b[0m';
    const out = stripPromptEcho(buffer, prompt);
    expect(out).toBe('The build succeeded with no warnings.');
    expect(out).not.toContain('summarize');
  });

  it('treats regex-special characters in the prompt literally', () => {
    const prompt = 'what is 2 + 2 (really)?';
    const buffer = 'what is 2 + 2 (really)?\r\nIt is four.';
    expect(stripPromptEcho(buffer, prompt)).toBe('It is four.');
  });

  it('returns the cleaned buffer when the prompt is not found', () => {
    const buffer = '\x1b[32mAgent output with no echo here.\x1b[0m';
    expect(stripPromptEcho(buffer, 'some other prompt')).toBe(
      'Agent output with no echo here.',
    );
  });

  it('returns the cleaned buffer when the prompt is empty', () => {
    expect(stripPromptEcho('  just output  ', '   ')).toBe('just output');
  });
});
