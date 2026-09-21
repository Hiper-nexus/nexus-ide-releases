/** Upgrade the standard login while respecting explicitly configured methods. */
export function codexDeviceLoginCommand(command: string, adapterId?: string): string {
  const trimmed = command.trim();
  return adapterId === 'codex' && trimmed === 'codex login'
    ? 'codex login --device-auth'
    : trimmed;
}
