declare function braceExpansion(
  str: string,
  options?: braceExpansion.BraceExpansionOptions,
): string[];

declare namespace braceExpansion {
  type BraceExpansionOptions = {
    max?: number;
    maxLength?: number;
    maxDepth?: number;
    maxRewrites?: number;
  };

  const EXPANSION_MAX: 100000;
  const EXPANSION_MAX_LENGTH: 4000000;
  const EXPANSION_MAX_DEPTH: 1000;
  const EXPANSION_MAX_REWRITES: 1000;
  const expand: typeof braceExpansion;
}

export = braceExpansion;
