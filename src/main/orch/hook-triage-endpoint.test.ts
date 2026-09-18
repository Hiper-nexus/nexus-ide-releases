import { describe, expect, it, vi } from 'vitest';
import {
  formatTriageContext,
  handleHookTriageRequest,
  parseBashFailure,
} from './hook-triage-endpoint';
import type { CommandTriage } from '../jev/jev-terminal-triage';

const ctx = { sessionId: 's1' };

describe('parseBashFailure', () => {
  it('parses the documented PostToolUseFailure payload', () => {
    expect(
      parseBashFailure({
        tool_name: 'Bash',
        tool_input: { command: 'npm test' },
        error: "Exit code 1\nError: Cannot find module 'express'",
      }),
    ).toEqual({
      command: 'npm test',
      exitCode: 1,
      output: "Error: Cannot find module 'express'",
    });
  });

  it('returns null for non-Bash tools', () => {
    expect(
      parseBashFailure({
        tool_name: 'Edit',
        tool_input: { command: 'npm test' },
        error: 'Exit code 1\nboom',
      }),
    ).toBeNull();
    expect(parseBashFailure(null)).toBeNull();
    expect(parseBashFailure({ tool_name: 'Bash' })).toBeNull();
  });

  it('returns null when tool_input or a non-empty command is missing', () => {
    expect(
      parseBashFailure({
        tool_name: 'Bash',
        error: 'Exit code 1\nboom',
      }),
    ).toBeNull();
    expect(
      parseBashFailure({
        tool_name: 'Bash',
        tool_input: 'não-objeto',
        error: 'Exit code 1\nboom',
      }),
    ).toBeNull();
    expect(
      parseBashFailure({
        tool_name: 'Bash',
        tool_input: { command: '   ' },
        error: 'Exit code 1\nboom',
      }),
    ).toBeNull();
    expect(
      parseBashFailure({
        tool_name: 'Bash',
        tool_input: { command: 42 },
        error: 'Exit code 1\nboom',
      }),
    ).toBeNull();
  });

  it('defaults exitCode to 1 and keeps the full text without an exit-code line', () => {
    expect(
      parseBashFailure({
        tool_name: 'Bash',
        tool_input: { command: 'make' },
        error: 'spawn make ENOENT\nmore detail',
      }),
    ).toEqual({
      command: 'make',
      exitCode: 1,
      output: 'spawn make ENOENT\nmore detail',
    });
  });
});

describe('formatTriageContext', () => {
  it('formats the kind label, confidence and retry hint in pt-BR', () => {
    const text = formatTriageContext({
      kind: 'environment',
      confidence: 0.82,
      retryHelps: 0.1,
      model: 'jev',
    });
    expect(text).toContain('[Nexus · Jev]');
    expect(text).toContain('ambiente da máquina');
    expect(text).toContain('0.82');
    expect(text).toContain('provavelmente falha igual');
    expect(text.length).toBeLessThanOrEqual(400);
  });
});

describe('handleHookTriageRequest', () => {
  it('returns hookSpecificOutput.additionalContext when triage has a verdict', async () => {
    const triage = vi.fn(
      async (): Promise<CommandTriage> => ({
        kind: 'environment',
        confidence: 0.82,
        retryHelps: 0.1,
        model: 'jev',
      }),
    );
    const result = await handleHookTriageRequest(
      ctx,
      {
        tool_name: 'Bash',
        tool_input: { command: 'npm test' },
        error: 'Exit code 1\nnode: command not found',
      },
      { triage },
    );
    expect(result.statusCode).toBe(200);
    const output = (result.payload as Record<string, unknown>)
      .hookSpecificOutput as Record<string, unknown>;
    expect(output.hookEventName).toBe('PostToolUseFailure');
    expect(String(output.additionalContext)).toContain('ambiente da máquina');
    expect(triage).toHaveBeenCalledWith(
      {
        command: 'npm test',
        exitCode: 1,
        output: 'node: command not found',
      },
      expect.anything(),
    );
  });

  it('returns {} for unparseable payloads without calling triage', async () => {
    const triage = vi.fn();
    const result = await handleHookTriageRequest(
      ctx,
      { tool_name: 'Edit', error: 'Exit code 1\nx' },
      { triage },
    );
    expect(result).toEqual({ statusCode: 200, payload: {} });
    expect(triage).not.toHaveBeenCalled();
  });

  it('returns {} when triage is unavailable (surface off / no credential)', async () => {
    const result = await handleHookTriageRequest(
      ctx,
      {
        tool_name: 'Bash',
        tool_input: { command: 'npm test' },
        error: 'Exit code 1\nboom',
      },
      { triage: vi.fn(async () => null) },
    );
    expect(result).toEqual({ statusCode: 200, payload: {} });
  });

  it('returns {} when triage throws — the hook never disturbs Claude', async () => {
    const result = await handleHookTriageRequest(
      ctx,
      {
        tool_name: 'Bash',
        tool_input: { command: 'npm test' },
        error: 'Exit code 1\nboom',
      },
      {
        triage: vi.fn(async () => {
          throw new Error('jev exploded');
        }),
      },
    );
    expect(result).toEqual({ statusCode: 200, payload: {} });
  });
});
