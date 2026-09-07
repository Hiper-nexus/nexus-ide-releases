// Region slicing for the detection engine. Ports the region heuristics from
// herdrdev/herdr src/detect/manifest.rs (~1286-1509): prompt markers `›`,
// block markers `• ■ ✗ ✓`, and box-border `─` rules.
//
// Fidelity note: Herdr slices a rendered terminal grid (logical lines after
// soft-wrap). Nexus slices a stripped PTY text tail, so offsets are computed
// in UTF-16 code units over `\n`-joined logical lines. The heuristics are
// identical; only the input fidelity differs (see detector.ts header).

export interface DetectionInput {
  screen: string;
  oscTitle: string;
  oscProgress: string;
}

function lineStartOffset(lines: string[], index: number): number {
  let offset = 0;
  const end = Math.min(index, lines.length);
  for (let i = 0; i < end; i++) {
    offset += lines[i].length + 1;
  }
  return offset;
}

function sliceFromLineIndex(
  content: string,
  lines: string[],
  index: number,
): string {
  return content.slice(Math.min(lineStartOffset(lines, index), content.length));
}

function regionCount(spec: string, name: string): number | null {
  if (!spec.startsWith(`${name}(`) || !spec.endsWith(')')) return null;
  const raw = spec.slice(name.length + 1, -1);
  // Rust's usize::from_str is all-or-nothing; parseInt would accept "12x".
  if (!/^[0-9]+$/.test(raw)) return null;
  const count = Number.parseInt(raw, 10);
  return Number.isSafeInteger(count) ? count : null;
}

function bottomLines(content: string, count: number): string {
  const lines = content.split('\n');
  return sliceFromLineIndex(content, lines, Math.max(0, lines.length - count));
}

function bottomNonEmptyLines(content: string, count: number): string {
  const lines = content.split('\n');
  let found = 0;
  let startIndex: number | null = null;
  for (let i = lines.length - 1; i >= 0 && found < count; i--) {
    if (lines[i].trim().length > 0) {
      found += 1;
      startIndex = i;
    }
  }
  if (startIndex === null) return '';
  return sliceFromLineIndex(content, lines, startIndex);
}

function topNonEmptyLines(content: string, count: number): string {
  const lines = content.split('\n');
  let found = 0;
  let endIndex: number | null = null;
  for (let i = 0; i < lines.length && found < count; i++) {
    if (lines[i].trim().length > 0) {
      found += 1;
      endIndex = i;
    }
  }
  if (endIndex === null) return '';
  return content.slice(0, lineStartOffset(lines, endIndex + 1));
}

function codexPromptLine(line: string): boolean {
  return line === '›' || line.startsWith('› ');
}

function codexBlockMarkerLine(line: string): boolean {
  return (
    line.startsWith('•') ||
    line.startsWith('■') ||
    line.startsWith('✗') ||
    line.startsWith('✓')
  );
}

/**
 * The last prompt marker is only "current" when no block marker follows it
 * (a completed block reclaims the marker line above it).
 */
function currentCodexPromptIndex(lines: string[]): number | null {
  let promptIndex: number | null = null;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (codexPromptLine(lines[i])) {
      promptIndex = i;
      break;
    }
  }
  if (promptIndex === null) return null;
  for (let i = promptIndex + 1; i < lines.length; i++) {
    if (codexBlockMarkerLine(lines[i])) return null;
  }
  return promptIndex;
}

function afterLastPromptMarker(content: string): string {
  const lines = content.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (codexPromptLine(lines[i])) {
      return sliceFromLineIndex(content, lines, i + 1);
    }
  }
  return content;
}

function beforeCurrentPromptMarker(content: string): string {
  const lines = content.split('\n');
  const index = currentCodexPromptIndex(lines);
  if (index === null) return content;
  return content.slice(0, Math.min(lineStartOffset(lines, index), content.length));
}

function wholeRecentWithoutCurrentPromptMarker(content: string): string {
  const lines = content.split('\n');
  return currentCodexPromptIndex(lines) === null ? content : '';
}

function currentPromptBlockMarker(content: string): string {
  const lines = content.split('\n');
  const promptIndex = currentCodexPromptIndex(lines);
  if (promptIndex === null) return '';
  for (let i = promptIndex - 1; i >= 0; i--) {
    if (codexBlockMarkerLine(lines[i])) return lines[i];
  }
  return '';
}

function afterCurrentPromptBlockMarker(content: string): string {
  const lines = content.split('\n');
  const promptIndex = currentCodexPromptIndex(lines);
  if (promptIndex === null) return '';
  for (let i = promptIndex - 1; i >= 0; i--) {
    if (codexBlockMarkerLine(lines[i])) {
      return sliceFromLineIndex(content, lines, i);
    }
  }
  return '';
}

function isHorizontalRule(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.length === 0) return false;
  let ruleChars = 0;
  while (ruleChars < trimmed.length && trimmed[ruleChars] === '─') {
    ruleChars += 1;
  }
  if (ruleChars === 0) return false;
  const suffix = trimmed.slice(ruleChars).trimStart();
  return suffix.length === 0 || ruleChars >= 3;
}

/**
 * The prompt box top border is the second-to-last horizontal rule on screen
 * (the input box is drawn as top border / body / bottom border).
 */
function promptBoxTopBorderIndex(lines: string[]): number | null {
  let borderCount = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (isHorizontalRule(lines[i])) {
      borderCount += 1;
      if (borderCount === 2) return i;
    }
  }
  return null;
}

function promptBoxBody(content: string): string {
  const lines = content.split('\n');
  const top = promptBoxTopBorderIndex(lines);
  if (top === null) return '';
  let endIndex = lines.length;
  for (let i = top + 1; i < lines.length; i++) {
    if (isHorizontalRule(lines[i])) {
      endIndex = i;
      break;
    }
  }
  const start = Math.min(lineStartOffset(lines, top + 1), content.length);
  const end = Math.min(lineStartOffset(lines, endIndex), content.length);
  return content.slice(start, end);
}

function abovePromptBox(content: string): string {
  const lines = content.split('\n');
  const top = promptBoxTopBorderIndex(lines);
  if (top === null) return content;
  return content.slice(0, Math.min(lineStartOffset(lines, top), content.length));
}

function lastNonEmptyLine(content: string): string {
  const lines = content.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trim().length > 0) return lines[i];
  }
  return '';
}

function afterLastHorizontalRule(content: string): string {
  const lines = content.split('\n');
  let lastRuleEnd = 0;
  let offset = 0;
  for (const line of lines) {
    const nextOffset = offset + line.length + 1;
    if (isHorizontalRule(line)) {
      lastRuleEnd = Math.min(nextOffset, content.length);
    }
    offset = nextOffset;
  }
  return content.slice(lastRuleEnd);
}

/** `region()`: slice the input for one rule's region spec. */
export function sliceRegion(input: DetectionInput, spec: string): string {
  const trimmed = spec.trim();
  if (trimmed === 'osc_title') return input.oscTitle;
  if (trimmed === 'osc_progress') return input.oscProgress;

  const content = input.screen;
  switch (trimmed) {
    case 'whole_recent':
      return content;
    case 'after_last_prompt_marker':
      return afterLastPromptMarker(content);
    case 'before_current_prompt_marker':
      return beforeCurrentPromptMarker(content);
    case 'whole_recent_without_current_prompt_marker':
      return wholeRecentWithoutCurrentPromptMarker(content);
    case 'current_prompt_block_marker':
      return currentPromptBlockMarker(content);
    case 'after_current_prompt_block_marker':
      return afterCurrentPromptBlockMarker(content);
    case 'prompt_box_body':
      return promptBoxBody(content);
    case 'above_prompt_box':
      return abovePromptBox(content);
    case 'last_non_empty_above_prompt_box':
      return lastNonEmptyLine(abovePromptBox(content));
    case 'after_last_horizontal_rule':
      return afterLastHorizontalRule(content);
    default: {
      const bottom = regionCount(trimmed, 'bottom_lines');
      if (bottom !== null) return bottomLines(content, bottom);
      const bottomNonEmpty = regionCount(trimmed, 'bottom_non_empty_lines');
      if (bottomNonEmpty !== null) {
        return bottomNonEmptyLines(content, bottomNonEmpty);
      }
      const top = regionCount(trimmed, 'top_non_empty_lines');
      if (top !== null) return topNonEmptyLines(content, top);
      return '';
    }
  }
}
