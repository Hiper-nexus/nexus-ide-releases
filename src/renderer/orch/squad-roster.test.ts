import { describe, expect, it } from 'vitest';
import type { SquadAgent } from '../../shared/orch-types';
import { balanceSquadRosterCli, workerCliPool } from './squad-roster';

function adapter(id: string, installed = true, enabled = true) {
  return { id, installed, enabled };
}

function agent(
  id: string,
  category: SquadAgent['category'],
  cli = 'claude',
  model = `${cli}-model`,
): SquadAgent {
  return {
    id,
    agentName: id,
    category,
    cli,
    model,
    effort: 'medium',
    allowedTools: [],
  };
}

describe('workerCliPool', () => {
  it('prefers enabled installed non-Claude CLIs in product order', () => {
    expect(
      workerCliPool([
        adapter('claude'),
        adapter('kimi'),
        adapter('codex'),
        adapter('agy', true, false),
        adapter('grok', false),
      ]),
    ).toEqual(['codex', 'kimi']);
  });

  it('falls back to configured non-Claude CLIs when only Claude is installed', () => {
    expect(
      workerCliPool([
        adapter('claude'),
        adapter('codex', false),
        adapter('agy', false),
      ]),
    ).toEqual(['codex', 'agy']);
  });

  it('reserves the configured orchestrator provider instead of hardcoding Claude', () => {
    expect(
      workerCliPool(
        [adapter('claude'), adapter('codex'), adapter('agy')],
        'codex',
      ),
    ).toEqual(['agy', 'claude']);
  });
});

describe('balanceSquadRosterCli', () => {
  it('keeps the orchestrator on Claude and distributes all workers', () => {
    const balanced = balanceSquadRosterCli(
      [
        agent('orch', 'orchestrator', 'codex'),
        agent('search', 'scout'),
        agent('code', 'executor'),
        agent('architect', 'architect'),
        agent('qa', 'reviewer'),
      ],
      [adapter('claude'), adapter('codex'), adapter('agy'), adapter('grok')],
    );

    expect(balanced.map((item) => item.cli)).toEqual([
      'claude',
      'codex',
      'agy',
      'grok',
      'codex',
    ]);
    expect(balanced[0].model).toBeUndefined();
    expect(balanced.slice(1).every((item) => item.model == null)).toBe(true);
  });

  it('moves the orchestrator to the configured MCP provider and preserves its matching model', () => {
    const balanced = balanceSquadRosterCli(
      [
        agent('orch', 'orchestrator', 'codex', 'gpt-5.4'),
        agent('worker', 'executor', 'claude'),
      ],
      [adapter('claude'), adapter('codex'), adapter('agy')],
      'codex',
    );

    expect(balanced[0]).toMatchObject({
      cli: 'codex',
      model: 'gpt-5.4',
    });
    expect(balanced[1].cli).not.toBe('codex');
  });

  it('preserves a worker model when the selected CLI does not change', () => {
    const [balanced] = balanceSquadRosterCli(
      [agent('frontend', 'executor', 'codex', 'gpt-5.5')],
      [adapter('codex')],
    );

    expect(balanced.cli).toBe('codex');
    expect(balanced.model).toBe('gpt-5.5');
  });

  it('uses the original worker CLI when no alternative exists', () => {
    const [balanced] = balanceSquadRosterCli(
      [agent('only', 'executor', 'claude', 'claude-sonnet-5')],
      [adapter('claude')],
    );

    expect(balanced.cli).toBe('claude');
    expect(balanced.model).toBe('claude-sonnet-5');
  });
});
