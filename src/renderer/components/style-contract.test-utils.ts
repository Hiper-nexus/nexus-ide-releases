export interface StyleContractEnvironment {
  width: number;
  /**
   * Viewport height. Required to exercise `@media (max-height: ...)`: the rail
   * compresses by HEIGHT, and without this every height branch was silently
   * dropped from the contract.
   */
  height?: number;
  reducedMotion?: boolean;
  pointer?: 'fine' | 'coarse';
  containerWidth?: number;
}

const STYLE_RULE = 1;
const MEDIA_RULE = 4;
const TEST_FOCUS_ATTRIBUTE = 'data-style-contract-focus-visible';

function endOfBlock(css: string, openingBrace: number): number {
  let depth = 1;
  let quote: '"' | "'" | null = null;
  let inComment = false;

  for (let index = openingBrace + 1; index < css.length; index += 1) {
    const current = css[index]!;
    const next = css[index + 1];

    if (inComment) {
      if (current === '*' && next === '/') {
        inComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (current === '\\') {
        index += 1;
      } else if (current === quote) {
        quote = null;
      }
      continue;
    }
    if (current === '/' && next === '*') {
      inComment = true;
      index += 1;
      continue;
    }
    if (current === '"' || current === "'") {
      quote = current;
      continue;
    }
    if (current === '{') depth += 1;
    if (current === '}') depth -= 1;
    if (depth === 0) return index;
  }

  throw new Error('Unterminated CSS at-rule block in style-contract fixture');
}

function containerConditionMatches(
  prelude: string,
  containerWidth: number | undefined,
): boolean {
  if (containerWidth === undefined) return false;
  const maxWidth = prelude.match(/max-width\s*:\s*(\d+(?:\.\d+)?)px/i);
  const minWidth = prelude.match(/min-width\s*:\s*(\d+(?:\.\d+)?)px/i);
  if (maxWidth && containerWidth > Number(maxWidth[1])) return false;
  if (minWidth && containerWidth < Number(minWidth[1])) return false;
  return maxWidth !== null || minWidth !== null;
}

/**
 * JSDOM's CSS parser does not expose CSSContainerRule yet. Materialize only the
 * branch for the supplied inline size, then let its CSSOM parse and cascade the
 * resulting real declarations. With no size, container-only rules are omitted.
 */
function materializeContainerQueries(
  css: string,
  containerWidth: number | undefined,
): string {
  let output = '';
  let cursor = 0;

  while (cursor < css.length) {
    const start = css.indexOf('@container', cursor);
    if (start < 0) {
      output += css.slice(cursor);
      break;
    }
    const openingBrace = css.indexOf('{', start);
    if (openingBrace < 0) {
      throw new Error('Container query has no declaration block');
    }
    const closingBrace = endOfBlock(css, openingBrace);
    output += css.slice(cursor, start);
    if (
      containerConditionMatches(
        css.slice(start, openingBrace),
        containerWidth,
      )
    ) {
      output += css.slice(openingBrace + 1, closingBrace);
    }
    cursor = closingBrace + 1;
  }

  return output;
}

function mediaBranchMatches(
  branch: string,
  environment: StyleContractEnvironment,
): boolean {
  const features = [...branch.matchAll(/\(([^)]+)\)/g)].map(
    (match) => match[1]!.trim().toLowerCase(),
  );
  if (features.length === 0) return false;

  return features.every((feature) => {
    const [rawName, rawValue = ''] = feature.split(':', 2);
    const name = rawName?.trim();
    const value = rawValue.trim();
    if (name === 'max-width') return environment.width <= Number.parseFloat(value);
    if (name === 'min-width') return environment.width >= Number.parseFloat(value);
    if (name === 'max-height') {
      if (environment.height === undefined) return false;
      return environment.height <= Number.parseFloat(value);
    }
    if (name === 'min-height') {
      if (environment.height === undefined) return false;
      return environment.height >= Number.parseFloat(value);
    }
    if (name === 'prefers-reduced-motion') {
      return value === (environment.reducedMotion ? 'reduce' : 'no-preference');
    }
    if (name === 'pointer') return value === (environment.pointer ?? 'fine');
    return false;
  });
}


function flattenedRules(
  rules: CSSRuleList,
  environment: StyleContractEnvironment,
): string[] {
  const output: string[] = [];

  for (const rule of Array.from(rules)) {
    if (rule.type === STYLE_RULE) {
      const styleRule = rule as CSSStyleRule;
      const selector = styleRule.selectorText.replaceAll(
        ':focus-visible',
        `[${TEST_FOCUS_ATTRIBUTE}]`,
      );
      output.push(`${selector} { ${styleRule.style.cssText} }`);
      continue;
    }
    if (rule.type === MEDIA_RULE) {
      const mediaRule = rule as CSSMediaRule;
      if (
        mediaRule.media.mediaText
          .split(',')
          .some((branch) => mediaBranchMatches(branch, environment))
      ) {
        output.push(...flattenedRules(mediaRule.cssRules, environment));
      }
    }
  }

  return output;
}

export function installStyleContract(
  sources: readonly string[],
  environment: StyleContractEnvironment,
): HTMLStyleElement {
  const activeRules: string[] = [];

  for (const source of sources) {
    const parser = document.createElement('style');
    parser.textContent = materializeContainerQueries(
      source,
      environment.containerWidth,
    );
    document.head.appendChild(parser);
    const sheet = parser.sheet;
    if (!sheet) {
      parser.remove();
      throw new Error('JSDOM did not expose CSSOM rules for a style contract');
    }
    activeRules.push(...flattenedRules(sheet.cssRules, environment));
    parser.remove();
  }

  const activeStyle = document.createElement('style');
  activeStyle.dataset.v2StyleContract = 'active';
  activeStyle.textContent = activeRules.join('\n');
  document.head.appendChild(activeStyle);
  return activeStyle;
}

export function activeCssomDeclaration(
  activeStyle: HTMLStyleElement,
  selector: string,
  property: string,
): string {
  const sheet = activeStyle.sheet;
  if (!sheet) {
    throw new Error('Active style contract has no CSSOM stylesheet');
  }
  let declaration = '';
  for (const rule of Array.from(sheet.cssRules)) {
    if (rule.type !== STYLE_RULE) continue;
    const styleRule = rule as CSSStyleRule;
    const ownsSelector = styleRule.selectorText
      .split(',')
      .some((candidate) => candidate.trim() === selector);
    if (!ownsSelector) continue;
    const candidate = styleRule.style.getPropertyValue(property).trim();
    if (candidate) declaration = candidate;
  }
  return declaration;
}

export function cssDeclarationHasPositiveDuration(
  declaration: string,
): boolean {
  return [...declaration.matchAll(/\d+(?:\.\d+)?(?:ms|s)/g)].some((match) => {
    const duration = match[0];
    const value = Number.parseFloat(duration);
    if (!Number.isFinite(value)) return false;
    return duration.endsWith('ms') ? value > 0 : value * 1_000 > 0;
  });
}

export function markFocusVisible<T extends HTMLElement>(element: T): T {
  element.focus();
  element.setAttribute(TEST_FOCUS_ATTRIBUTE, '');
  return element;
}

function customProperty(element: Element, name: string): string {
  const inherited = getComputedStyle(element).getPropertyValue(name).trim();
  if (inherited) return inherited;
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

export function computedCssValue(
  element: Element,
  property: string,
): string {
  let value = getComputedStyle(element).getPropertyValue(property).trim();
  for (let pass = 0; pass < 12 && value.includes('var('); pass += 1) {
    value = value.replace(
      /var\(\s*(--[\w-]+)\s*(?:,\s*([^()]+))?\)/g,
      (_match, name: string, fallback: string | undefined) =>
        customProperty(element, name) || fallback?.trim() || '',
    );
  }
  return value.replace(/\s+/g, ' ').trim();
}

export function styleLengthPx(element: Element, property: string): number {
  const value = computedCssValue(element, property);
  if (value === '' || value === 'auto' || value === 'none' || value === 'normal') {
    return 0;
  }
  if (/^-?\d+(?:\.\d+)?$/.test(value)) return Number(value);
  if (/^-?\d+(?:\.\d+)?px$/.test(value)) return Number.parseFloat(value);

  const expression = value.replace(/^calc\((.*)\)$/i, '$1');
  const terms = [...expression.matchAll(/([+-]?)\s*(\d+(?:\.\d+)?)px/g)];
  if (terms.length === 0) return Number.NaN;
  return terms.reduce(
    (total, term) => total + (term[1] === '-' ? -1 : 1) * Number(term[2]),
    0,
  );
}

export function styleTracks(element: Element, property: string): string[] {
  const value = computedCssValue(element, property);
  const tracks: string[] = [];
  let current = '';
  let depth = 0;

  for (const character of value) {
    if (character === '(') depth += 1;
    if (character === ')') depth -= 1;
    if (/\s/.test(character) && depth === 0) {
      if (current) tracks.push(current);
      current = '';
    } else {
      current += character;
    }
  }
  if (current) tracks.push(current);
  return tracks;
}

