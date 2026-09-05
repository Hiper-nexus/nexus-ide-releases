/** Operates only on the confirmed snapshot, stopping if the project changes. */
export async function runCleanupBatch<T>(
  items: readonly T[],
  isCurrentProject: () => boolean,
  remove: (item: T) => Promise<boolean>,
): Promise<{ completed: number; failed: number; interrupted: boolean }> {
  let completed = 0;
  let failed = 0;
  for (const item of items) {
    if (!isCurrentProject()) return { completed, failed, interrupted: true };
    try {
      if (await remove(item)) completed += 1;
      else failed += 1;
    } catch (error) {
      console.error('[workspace-cleanup] item failed', error);
      failed += 1;
    }
  }
  return { completed, failed, interrupted: !isCurrentProject() };
}
