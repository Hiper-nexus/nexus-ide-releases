import { describe, expect, it } from 'vitest';
import { buildDomainTools } from './tools-domain';

describe('T7 Superfície MCP (cron aliases, recipes lint/format, perf events)', () => {
  const tools = buildDomainTools();

  it('todas as ferramentas T7 estão registradas no catálogo de tools', () => {
    const toolNames = tools.map((t) => t.name);
    expect(toolNames).toContain('nexus_cron_schedule');
    expect(toolNames).toContain('nexus_cron_list');
    expect(toolNames).toContain('nexus_cron_cancel');
    expect(toolNames).toContain('nexus_recipes_lint');
    expect(toolNames).toContain('nexus_recipes_format');
    expect(toolNames).toContain('nexus_perf_events');
  });

  describe('nexus_recipes_lint', () => {
    const lintTool = tools.find((t) => t.name === 'nexus_recipes_lint')!;

    it('valida squad válido com sucesso', async () => {
      const validSquad = {
        id: 'test-squad',
        name: 'Test Squad',
        createdAt: '1700000000',
        builtin: false,
        orchestratorInstructions: 'Instruções do orquestrador de teste.',
        agents: [
          {
            id: 'orch',
            agentName: 'Orchestrator',
            category: 'orchestrator',
            cli: 'claude',
            effort: 'high',
          },
        ],
      };

      const result = await lintTool.handler(
        { recipe: validSquad },
        {} as never,
        { current: true } as never,
      );

      expect(result).toMatchObject({ valid: true });
      expect((result as { valid: boolean; squad: unknown }).squad).toBeDefined();
    });

    it('rejeita squad inválido e lista erros com path e mensagem', async () => {
      const brokenSquad = {
        name: 'Missing ID and agents',
      };

      const result = (await lintTool.handler(
        { recipe: brokenSquad },
        {} as never,
        { current: true } as never,
      )) as { valid: boolean; errors: Array<{ path: string; message: string }> };

      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors.some((e) => e.path.includes('id'))).toBe(true);
    });
  });

  describe('nexus_recipes_format', () => {
    const formatTool = tools.find((t) => t.name === 'nexus_recipes_format')!;

    it('formata squad válido e devolve JSON identado', async () => {
      const validSquad = {
        id: 'format-squad',
        name: 'Format Squad',
        createdAt: '1700000000',
        builtin: false,
        orchestratorInstructions: 'Instruções',
        agents: [
          {
            id: 'orch',
            agentName: 'Orch',
            category: 'orchestrator',
            cli: 'claude',
            effort: 'medium',
          },
        ],
      };

      const result = (await formatTool.handler(
        { recipe: validSquad },
        {} as never,
        { current: true } as never,
      )) as { formattedJson: string; squad: unknown };

      expect(typeof result.formattedJson).toBe('string');
      expect(result.formattedJson).toContain('"id": "format-squad"');
      expect(result.squad).toBeDefined();
    });

    it('rejeita dados não-squad lançando erro descritivo', async () => {
      await expect(
        formatTool.handler(
          { recipe: { invalid: true } },
          {} as never,
          { current: true } as never,
        ),
      ).rejects.toThrow('Recipe inválido para formatação');
    });
  });

  describe('nexus_perf_events', () => {
    const perfTool = tools.find((t) => t.name === 'nexus_perf_events')!;

    it('devolve métricas de performance estruturadas com campos conhecidos', async () => {
      const snapshot = (await perfTool.handler(
        {},
        {} as never,
        { current: true } as never,
      )) as Record<string, unknown>;

      expect(snapshot).toHaveProperty('capturedAt');
      expect(snapshot).toHaveProperty('process');
      expect(snapshot).toHaveProperty('panes');
      expect(snapshot).toHaveProperty('warmPool');
      expect(snapshot.warmPool).toHaveProperty('hits');
      expect(snapshot.warmPool).toHaveProperty('misses');
      expect(snapshot.warmPool).toHaveProperty('readyCount');
    });
  });
});
