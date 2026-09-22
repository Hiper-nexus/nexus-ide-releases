/** Classify what Nexus can prove about the executable a pane will launch. */
export function assessCliUpdate(input: {
  readonly beforeBin: string;
  readonly beforeVersion: string | null;
  readonly afterBin: string;
  readonly afterVersion: string;
  readonly platform: NodeJS.Platform;
}): 'updated' | 'unchanged' | 'verified' | 'different-launcher' {
  const normalize = (value: string) => {
    const path = value.replaceAll('\\', '/');
    return input.platform === 'win32' ? path.toLowerCase() : path;
  };
  if (normalize(input.beforeBin) !== normalize(input.afterBin)) {
    return 'different-launcher';
  }
  if (input.beforeVersion === null) return 'verified';
  return input.beforeVersion === input.afterVersion ? 'unchanged' : 'updated';
}
