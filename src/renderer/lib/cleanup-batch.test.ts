import { expect, it, vi } from 'vitest';
import { runCleanupBatch } from './cleanup-batch';
it('continues after an item fails and reports partial completion', async () => {
  const remove = vi.fn().mockResolvedValueOnce(true).mockRejectedValueOnce(new Error('falhou')).mockResolvedValueOnce(false);
  expect(await runCleanupBatch(['a', 'b', 'c'], () => true, remove)).toEqual({ completed: 1, failed: 2, interrupted: false });
});
it('stops before touching another project after an asynchronous operation', async () => {
  let current = true;
  const remove = vi.fn(async () => { current = false; return true; });
  expect(await runCleanupBatch(['a', 'b'], () => current, remove)).toEqual({ completed: 1, failed: 0, interrupted: true });
  expect(remove).toHaveBeenCalledTimes(1);
});
