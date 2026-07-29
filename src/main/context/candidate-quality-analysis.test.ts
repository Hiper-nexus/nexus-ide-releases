import { describe, expect, it } from 'vitest';
import {
  analyzeCandidateQualityFacts,
  type CandidateQualitySourceFact,
} from './candidate-quality-analysis';

function source(
  relativePath: string,
  content: string,
  addedLines: readonly [number, number][] = [[1, 1_000]],
): CandidateQualitySourceFact {
  return Object.freeze({
    relativePath,
    content,
    addedLines: Object.freeze(
      addedLines.map(([start, end]) => Object.freeze({ start, end })),
    ),
  });
}

describe('candidate quality analysis', () => {
  it('blocks newly introduced unreachable code and privileged renderer imports', () => {
    const findings = analyzeCandidateQualityFacts({
      changedFiles: ['src/renderer/panel.ts'],
      sources: [
        source(
          'src/renderer/panel.ts',
          [
            "import { readFile } from 'node:fs';",
            'export function renderPanel(): string {',
            "  return 'ready';",
            "  console.log(readFile);",
            '}',
          ].join('\n'),
        ),
      ],
    });

    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: 'critical',
          category: 'security',
          file: 'src/renderer/panel.ts',
          line: 1,
        }),
        expect.objectContaining({
          severity: 'high',
          category: 'correctness',
          file: 'src/renderer/panel.ts',
          line: 4,
        }),
      ]),
    );
  });

  it('does not blame a touched file for unreachable code outside added lines', () => {
    const findings = analyzeCandidateQualityFacts({
      changedFiles: ['src/existing.ts'],
      sources: [
        source(
          'src/existing.ts',
          [
            'export function existing(): number {',
            '  return 1;',
            '  console.log("legacy");',
            '}',
            'export const newlyAdded = 2;',
          ].join('\n'),
          [[5, 5]],
        ),
      ],
    });

    expect(
      findings.some((finding) => /unreachable/i.test(finding.evidence)),
    ).toBe(false);
  });

  it('reports exact implementation duplication, similar exported APIs and dead local functions', () => {
    const implementation = [
      '  const normalized = value.trim().toLowerCase();',
      '  const pieces = normalized.split(/\\s+/u);',
      '  return pieces.filter(Boolean).map((part) => part.slice(0, 20)).join("-");',
    ].join('\n');
    const findings = analyzeCandidateQualityFacts({
      changedFiles: ['src/new-normalizer.ts'],
      sources: [
        source(
          'src/existing-normalizer.ts',
          [
            'export function normalizeMissionLabel(value: string): string {',
            implementation,
            '}',
          ].join('\n'),
          [],
        ),
        source(
          'src/new-normalizer.ts',
          [
            'export function normalizeMissionLabels(value: string): string {',
            implementation,
            '}',
            '',
            'function abandonedMissionHelper(): void {',
            '  console.log("never called");',
            '}',
          ].join('\n'),
        ),
      ],
    });

    expect(
      findings.some((finding) => /duplicate implementation/i.test(finding.evidence)),
    ).toBe(true);
    expect(
      findings.some((finding) => /similar exported API/i.test(finding.evidence)),
    ).toBe(true);
    expect(
      findings.some((finding) => /unreferenced local function/i.test(finding.evidence)),
    ).toBe(true);
  });

  it('surfaces bounded blast radius and missing test coverage evidence', () => {
    const findings = analyzeCandidateQualityFacts({
      changedFiles: ['src/core/hub.ts'],
      sources: [
        source(
          'src/core/hub.ts',
          'export function resolveSharedMission(value: string): string { return value.trim(); }',
        ),
        ...Array.from({ length: 5 }, (_, index) =>
          source(
            `src/consumer-${index}.ts`,
            `import { resolveSharedMission } from './core/hub';\n` +
              `export const value${index} = resolveSharedMission('x');`,
            [],
          ),
        ),
      ],
    });

    expect(
      findings.some((finding) => /blast radius/i.test(finding.evidence)),
    ).toBe(true);
    expect(
      findings.some((finding) => /test coverage gap/i.test(finding.evidence)),
    ).toBe(true);
  });

  it('accepts a real importing test as coverage evidence', () => {
    const findings = analyzeCandidateQualityFacts({
      changedFiles: ['src/core/value.ts'],
      sources: [
        source(
          'src/core/value.ts',
          'export function resolveValue(value: string): string { return value.trim(); }',
        ),
        source(
          'src/core/value.test.ts',
          "import { resolveValue } from './value';\n" +
            "it('trims', () => expect(resolveValue(' x ')).toBe('x'));",
          [],
        ),
      ],
    });

    expect(
      findings.some((finding) => /test coverage gap/i.test(finding.evidence)),
    ).toBe(false);
  });
});
