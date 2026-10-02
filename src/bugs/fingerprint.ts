import { hashToken } from '../crypto.js';
import type { BugCategory } from './constants.js';

/** Minúsculas, sem acento, sem número e sem pontuação: "Terminal fecha, 3x!" e "terminal fecha" são o mesmo problema. */
export function normalizeTitle(title: string): string {
  return title.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
    .replace(/[\p{N}\p{P}\p{S}]/gu, ' ').replace(/\s+/g, ' ').trim();
}

/** "0.76.110" -> "0.76": um bug muda de natureza entre versões menores, não entre correções. */
export function majorMinor(version: string): string {
  const match = /^(\d+)\.(\d+)/.exec(version);
  return match ? `${match[1]}.${match[2]}` : version;
}

export interface FingerprintInput { readonly title: string; readonly category: BugCategory; readonly appVersion: string }

/** sha256 de (título normalizado + categoria + major.minor): agrupa relatos repetidos do mesmo problema. */
export function reportFingerprint(input: FingerprintInput): Promise<string> {
  return hashToken([normalizeTitle(input.title), input.category, majorMinor(input.appVersion)].join('\n'));
}
