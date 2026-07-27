declare function braceExpansion(
  str: string,
  options?: braceExpansion.BraceExpansionOptions,
): string[];

declare namespace braceExpansion {
  type BraceExpansionOptions = {
    max?: number;
    maxLength?: number;
  };

  const EXPANSION_MAX: 100000;
  const EXPANSION_MAX_LENGTH: 4000000;
  const expand: typeof braceExpansion;
}

export = braceExpansion;
