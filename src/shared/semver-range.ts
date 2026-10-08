// Adapted from pingdotgg/t3code @ 26285ab80513260d1ff29d2c3fbe18f21990cb62
// Copyright (c) 2026 T3 Tools Inc. — MIT License
// See third_party/licenses/t3code-MIT.txt. Nexus changes: só o
// `satisfiesSemverRange` de packages/shared/src/semver.ts, em TypeScript comum
// (sem a restrição de corpo JS stringificável do SSH); comparação de versões
// segue em src/shared/app-version.ts.

type Triple = { readonly major: number; readonly minor: number; readonly patch: number };

const VERSION = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-[0-9A-Za-z.-]+)?$/;
const COMPARATOR = /^(\^|>=|>|<=|<|=)?\s*v?(\d+)(?:\.(\d+))?(?:\.(\d+))?$/;

function triple(match: RegExpMatchArray, offset: number): Triple {
  return {
    major: Number(match[offset]),
    minor: Number(match[offset + 1] || 0),
    patch: Number(match[offset + 2] || 0),
  };
}

function compare(left: Triple, right: Triple): number {
  return Math.sign(left.major - right.major) ||
    Math.sign(left.minor - right.minor) ||
    Math.sign(left.patch - right.patch);
}

/**
 * Faixa de versão de CLI: comparadores separados por espaço (`>=1.2.0 <2.0.0`)
 * e grupos com `||`. Versão ilegível ou comparador desconhecido → false, nunca
 * exceção — a política trata isso como "desconhecida".
 */
export function satisfiesSemverRange(rawVersion: string, range: string): boolean {
  const versionMatch = String(rawVersion).trim().replace(/^v/, '').match(VERSION);
  if (!versionMatch) return false;
  const version = triple(versionMatch, 1);
  return range.split('||').some((group) => {
    const comparators = group.trim().split(/\s+/).filter(Boolean);
    if (comparators.length === 0) return false;
    return comparators.every((comparator) => {
      const match = comparator.trim().match(COMPARATOR);
      if (!match) return false;
      const target = triple(match, 2);
      const compared = compare(version, target);
      switch (match[1] || '=') {
        case '^':
          if (compared < 0) return false;
          if (target.major > 0) return version.major === target.major;
          if (target.minor > 0) return version.major === 0 && version.minor === target.minor;
          return version.major === 0 && version.minor === 0 && version.patch === target.patch;
        case '>=':
          return compared >= 0;
        case '>':
          return compared > 0;
        case '<=':
          return compared <= 0;
        case '<':
          return compared < 0;
        case '=':
          return compared === 0;
        default:
          return false;
      }
    });
  });
}
