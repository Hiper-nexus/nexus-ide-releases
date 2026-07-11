import { createHash } from 'node:crypto';
import type {
  ContextFact,
  ContextSourceRef,
} from './context-types';

/**
 * Adapter that turns a DESIGN.md document into structured context facts.
 *
 * DESIGN.md has no strict schema, but the curated kits on designmd.ai follow
 * a predictable outline: sections such as "Color Palette", "Typography",
 * "Spacing" and "Components" with key/value list items. This adapter extracts
 * those entries so the context corpus can reason about design decisions
 * instead of treating the document as an opaque blob.
 */

const DESIGN_SECTIONS = new Map<string, string>([
  ['color palette', 'color'],
  ['colors', 'color'],
  ['typography', 'typography'],
  ['fonts', 'typography'],
  ['spacing', 'spacing'],
  ['layout', 'layout'],
  ['components', 'components'],
  ['icons', 'icons'],
  ['motion', 'motion'],
  ['animation', 'motion'],
]);

/** Guard against a huge DESIGN.md turning the context corpus into a fact bomb. */
const MAX_DESIGN_FACTS = 2048;

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function sanitizeId(raw: string): string {
  const normalized = raw
    .toLowerCase()
    .replace(/[^a-z0-9._:-]+/g, '-')
    .replace(/^-|-$/g, '');
  if (!normalized || !ID_PATTERN.test(normalized)) {
    return `design-${sha256(raw).slice(0, 16)}`;
  }
  return normalized;
}

function parseSectionHeading(line: string): string | null {
  const match = line.match(/^#{1,3}\s+(.+)$/);
  if (!match) return null;
  return match[1].trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function parseListItem(line: string): { key: string; value: string } | null {
  const trimmed = line.trim();
  const match = trimmed.match(/^[-*]\s+(.+)$/);
  if (!match) return null;
  const text = match[1].trim();
  const kv = text.match(/^([^:]+):\s*(.+)$/);
  if (kv) {
    return {
      key: kv[1].trim(),
      value: kv[2].trim(),
    };
  }
  return { key: text, value: text };
}

export function extractDesignSystemFacts(
  content: string,
  source: ContextSourceRef,
  sourceHash: string,
): readonly ContextFact[] {
  const facts: ContextFact[] = [];
  const lines = content.split('\n');
  let currentDomain: string | null = null;
  let currentSection: string | null = null;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const heading = parseSectionHeading(line);
    if (heading) {
      let matched = false;
      for (const [pattern, domain] of DESIGN_SECTIONS.entries()) {
        if (heading.includes(pattern)) {
          currentDomain = domain;
          currentSection = heading;
          matched = true;
          break;
        }
      }
      if (!matched) {
        currentDomain = null;
        currentSection = null;
      }
      continue;
    }

    const item = parseListItem(line);
    if (!item || !currentDomain) continue;
    if (facts.length >= MAX_DESIGN_FACTS) continue;

    const claimKey = sanitizeId(`${currentDomain}-${item.key}`);
    const id = `design-fact-${sha256(`${source.locator}\0${claimKey}\0${index}`).slice(0, 24)}`;
    facts.push(Object.freeze({
      id,
      projectId: '', // filled by the ingestor
      statement: `${currentSection ?? currentDomain}: ${item.key}`,
      claimKey,
      value: item.value,
      kind: 'observed',
      category: 'architecture',
      source: Object.freeze({ ...source }),
      sourceHash,
      domains: Object.freeze([currentDomain]),
      relatedSymbols: Object.freeze([]),
      confidence: 1,
      validFrom: '1970-01-01T00:00:00.000Z',
    }));
  }

  return Object.freeze(facts);
}
