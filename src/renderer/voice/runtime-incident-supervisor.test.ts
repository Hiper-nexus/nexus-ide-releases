import { describe, expect, it, vi } from 'vitest';
import { superviseJarvisAction } from './runtime-incident-supervisor';

function result(ok: boolean, summary: string) {
  return {
    sayText: summary,
    toolResult: { tool: 'design_squad' as const, ok, summary },
  };
}

describe('runtime incident supervisor', () => {
  it('propagates a clean parent cancellation without creating a Doctor incident', async () => {
    const parent = new AbortController();
    const execute = vi.fn(async () => {
      parent.abort('provider-cancelled');
      throw new Error('Jarvis action cancelled');
    });

    await expect(
      superviseJarvisAction(
        { type: 'read_current_view' },
        execute,
        { signal: parent.signal },
      ),
    ).rejects.toThrow('Jarvis action cancelled');
    expect(execute).toHaveBeenCalledOnce();
  });

  it('retries a signed recoverable JSON failure once', async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce(result(false, 'o modelo não devolveu JSON'))
      .mockResolvedValueOnce(result(true, 'squad criado'));
    const supervised = await superviseJarvisAction({ type: 'design_squad' }, execute);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(supervised.result.toolResult?.ok).toBe(true);
    expect(supervised.incidents).toHaveLength(1);
    expect(supervised.incidents[0].recovered).toBe(true);
  });

  it('never retries an action that may have committed an effect', async () => {
    const execute = vi.fn(async (control) => {
      control.onEffectMayHaveCommitted?.();
      return result(false, 'o modelo não devolveu JSON');
    });
    const supervised = await superviseJarvisAction({ type: 'design_squad' }, execute);
    expect(execute).toHaveBeenCalledOnce();
    expect(supervised.incidents[0].effectMayHaveCommitted).toBe(true);
  });

  it('does not retry non-whitelisted side-effect actions', async () => {
    const execute = vi.fn().mockResolvedValue({
      sayText: 'falhou',
      toolResult: { tool: 'send_to_pane', ok: false, summary: 'pane indisponível' },
    });
    const supervised = await superviseJarvisAction(
      { type: 'send_to_pane', text: 'continue' },
      execute,
    );
    expect(execute).toHaveBeenCalledOnce();
    expect(supervised.incidents[0].code).toBe('postcondition-failed');
  });

  it('rejects announced success without a measurable postcondition', async () => {
    const supervised = await superviseJarvisAction(
      { type: 'open_terminal' },
      async () => ({ sayText: 'Pronto.', toolResult: null }),
    );
    expect(supervised.result.toolResult?.ok).toBe(false);
    expect(supervised.incidents[0]).toMatchObject({
      code: 'postcondition-failed',
      recovered: false,
    });
  });
});
