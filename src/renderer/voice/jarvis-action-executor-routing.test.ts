import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

describe('Jarvis action execution routing', () => {
  const source = readFileSync(new URL('./jarvis-action-executor.ts', import.meta.url), 'utf8');

  it('routes ordinary terminal commands directly to the shell confirmation branch', () => {
    const mcpFirst = source.slice(source.indexOf('const mcpFirst'), source.indexOf('let toolResult'));
    expect(mcpFirst).not.toContain("'run_command'");
    expect(source).toContain("action.type === 'run_command'");
    expect(source).toContain("action.command.trim() === 'I' ? 'ai' : action.command");
    expect(source).toContain('confirmCommand(terminalCommand)');
    expect(source).toContain('writeToPane(targetPaneId, `${terminalCommand}\\n`)');
    expect(source).not.toContain("text: 'Confirma na tela para eu executar.'");
  });

  it('recovers a mistaken send_to_pane into the focused shell behind confirmation', () => {
    expect(source).toContain("recoveredFrom: 'send_to_pane'");
    expect(source).toContain('confirmCommand(action.text)');
    expect(source).toContain('writeToPane(focused.id, `${action.text}\\n`)');
  });
});
