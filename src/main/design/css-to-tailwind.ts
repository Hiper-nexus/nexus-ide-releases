import { CssToTailwindTranslator } from '../../vendor/onlook-css-to-tailwind/tailwind';

/**
 * Thin, typed facade over the vendored Onlook CSS→Tailwind translator
 * (Apache-2.0 — see src/vendor/onlook-css-to-tailwind/NOTICE). Converts a
 * sidebar style diff into Tailwind classes for the deterministic write-back
 * (VISUAL-EDIT-001, F3); anything the translator can't express is reported so
 * the caller can fall back to inline style (or the agent).
 */

export interface TailwindConversion {
  classes: string[];
  unsupported: Record<string, string>;
}

export function styleDiffToTailwind(
  styles: Record<string, string>,
): TailwindConversion {
  const entries = Object.entries(styles);
  if (!entries.length) return { classes: [], unsupported: {} };

  const classes: string[] = [];
  const unsupported: Record<string, string> = {};
  for (const [property, value] of entries) {
    // One property per call keeps the mapping property→classes exact, so a
    // single unsupported property never poisons the whole diff.
    const result = CssToTailwindTranslator(`.nx { ${property}: ${value} }`);
    const resultVal = result.code === 'OK' ? result.data[0]?.resultVal ?? '' : '';
    if (!resultVal.trim()) {
      unsupported[property] = value;
      continue;
    }
    classes.push(...resultVal.split(/\s+/).filter(Boolean));
  }
  return { classes, unsupported };
}
