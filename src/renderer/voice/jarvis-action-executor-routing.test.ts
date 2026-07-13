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

  it('opens the saved-squad picker without launching or designing a squad', () => {
    const pickerBranch = source.slice(
      source.indexOf("action.type === 'open_squad_picker'"),
      source.indexOf("action.type === 'open_squad'"),
    );
    expect(pickerBranch).toContain('openSquadPicker()');
    expect(pickerBranch).toContain("wizard.visibleStep === 'squad-select'");
    expect(pickerBranch).not.toContain('launchSquadMission');
    expect(pickerBranch).not.toContain('designSquad');
  });

  it('closes the squad picker and confirms the named squad after launch', () => {
    const squadBranch = source.slice(
      source.indexOf("action.type === 'open_squad'"),
      source.indexOf("action.type === 'open_workspace'"),
    );

    expect(squadBranch).toContain('useMissionWizardStore.getState().close()');
    expect(squadBranch).toContain('Squad ${match.name} iniciado.');
    expect(squadBranch.indexOf('if (res.ok)')).toBeLessThan(
      squadBranch.indexOf('useMissionWizardStore.getState().close()'),
    );
  });
});
