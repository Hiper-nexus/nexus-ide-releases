import fs from 'node:fs';
import path from 'node:path';
import type { ScanInput } from './skill-threat-scan';

const MAX_SKILL_TREE_DEPTH = 16;
const MAX_SKILL_TREE_FILES = 512;
const MAX_SKILL_TREE_BYTES = 16 * 1024 * 1024;
const MAX_SKILL_ASSET_BYTES = 4 * 1024 * 1024;

export type AgentPluginSkillTreeVerdict =
  | { readonly ok: true; readonly files: readonly ScanInput[] }
  | {
      readonly ok: false;
      readonly kind: 'invalid' | 'unsafe';
      readonly reason: string;
    };

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export function inspectAgentPluginSkillTree(
  pluginRoot: string,
  skillDir: string,
): AgentPluginSkillTreeVerdict {
  const files: ScanInput[] = [];
  let totalBytes = 0;

  function visit(entry: string, relative: string, depth: number): AgentPluginSkillTreeVerdict | null {
    if (depth > MAX_SKILL_TREE_DEPTH) {
      return {
        ok: false,
        kind: 'invalid',
        reason: `skill excede profundidade máxima de ${MAX_SKILL_TREE_DEPTH}`,
      };
    }
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(entry);
    } catch {
      return { ok: false, kind: 'invalid', reason: `entrada ilegível: ${relative}` };
    }
    if (stat.isSymbolicLink()) {
      return {
        ok: false,
        kind: 'unsafe',
        reason: `skill contém link simbólico não confiável: ${relative}`,
      };
    }
    let realEntry: string;
    try {
      realEntry = fs.realpathSync(entry);
    } catch {
      return { ok: false, kind: 'invalid', reason: `entrada ilegível: ${relative}` };
    }
    if (!isInside(pluginRoot, realEntry)) {
      return {
        ok: false,
        kind: 'unsafe',
        reason: `skill resolve fora da raiz do plugin: ${relative}`,
      };
    }
    if (stat.isDirectory()) {
      let children: string[];
      try {
        children = fs.readdirSync(realEntry);
      } catch {
        return { ok: false, kind: 'invalid', reason: `diretório ilegível: ${relative}` };
      }
      for (const child of children) {
        const childRelative = relative ? path.join(relative, child) : child;
        const verdict = visit(path.join(realEntry, child), childRelative, depth + 1);
        if (verdict) return verdict;
      }
      return null;
    }
    if (!stat.isFile()) {
      return {
        ok: false,
        kind: 'unsafe',
        reason: `skill contém entrada não regular: ${relative}`,
      };
    }
    if (stat.size > MAX_SKILL_ASSET_BYTES) {
      return {
        ok: false,
        kind: 'invalid',
        reason: `asset excede ${MAX_SKILL_ASSET_BYTES} bytes: ${relative}`,
      };
    }
    totalBytes += stat.size;
    if (files.length >= MAX_SKILL_TREE_FILES || totalBytes > MAX_SKILL_TREE_BYTES) {
      return {
        ok: false,
        kind: 'invalid',
        reason: `skill excede os limites de ${MAX_SKILL_TREE_FILES} arquivos/${MAX_SKILL_TREE_BYTES} bytes`,
      };
    }
    try {
      files.push({ name: relative, buffer: fs.readFileSync(realEntry) });
    } catch {
      return { ok: false, kind: 'invalid', reason: `arquivo ilegível: ${relative}` };
    }
    return null;
  }

  const verdict = visit(skillDir, '', 0);
  return verdict ?? { ok: true, files: Object.freeze(files) };
}
