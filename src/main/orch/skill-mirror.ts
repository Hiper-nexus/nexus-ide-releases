import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PONYTAIL_RULES } from './ponytail';
import { BUILTIN_BRIDGEMIND_SKILLS } from './bridge-mind-skills';

const GENERATED_PONYTAIL_SKILL = `---
name: ponytail
description: Use for lean senior implementation: reuse existing code, avoid speculative abstractions, and write the smallest correct diff.
---

${PONYTAIL_RULES}
`;

interface SkillSource {
  name: string;
  dir: string;
}

export interface SkillMirrorResult {
  mirrored: number;
  targetDirs: string[];
}

export interface SkillMirrorOptions {
  home?: string;
  sourceDirs?: string[];
  generatedRoot?: string;
  allowedSkills?: string[] | null;
  ephemeralHomeDir?: string | null;
}

function skillName(name: string): string {
  return name.trim().toLowerCase();
}

function defaultSourceDirs(home: string): string[] {
  return [
    path.join(home, '.agents', 'skills'),
    path.join(home, '.claude', 'skills'),
    path.join(home, '.codex', 'skills'),
    path.join(home, '.gemini', 'config', 'skills'),
    path.join(home, '.gemini', 'antigravity', 'skills'),
    path.join(home, '.gemini', 'antigravity-cli', 'skills'),
    path.join(home, '.gemini', 'antigravity-ide', 'skills'),
    path.join(home, '.kimi-code', 'skills'),
    path.join(home, '.grok', 'skills'),
    path.join(home, '.config', 'opencode', 'skills'),
  ];
}

function writeGeneratedSkills(root: string): string {
  const dir = path.join(root, 'ponytail');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), GENERATED_PONYTAIL_SKILL);
  for (const skill of BUILTIN_BRIDGEMIND_SKILLS) {
    const skillDir = path.join(root, skill.name);
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), skill.body);
  }
  return root;
}

function readSkillSources(sourceDirs: string[]): Map<string, SkillSource> {
  const sources = new Map<string, SkillSource>();
  for (const sourceDir of sourceDirs) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(sourceDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const dir = path.join(sourceDir, entry.name);
      if (!fs.existsSync(path.join(dir, 'SKILL.md'))) continue;
      const name = skillName(entry.name);
      if (!sources.has(name)) sources.set(name, { name, dir });
    }
  }
  return sources;
}

function allowedSet(allowedSkills: string[] | null | undefined): Set<string> | null {
  if (allowedSkills == null) return null;
  return new Set(allowedSkills.map(skillName).filter(Boolean));
}

function selectSources(
  sources: Map<string, SkillSource>,
  allowedSkills: string[] | null | undefined,
): SkillSource[] {
  const allowed = allowedSet(allowedSkills);
  if (allowed && allowed.size === 0) return [];
  return [...sources.values()].filter((source) => !allowed || allowed.has(source.name));
}

function cliSkillDirs(adapterId: string, home: string): string[] {
  switch (adapterId) {
    case 'claude':
    case 'glm':
    case 'longcat':
      return [path.join(home, '.claude', 'skills')];
    case 'codex':
      return [path.join(home, '.codex', 'skills')];
    case 'agy':
      return [
        path.join(home, '.gemini', 'config', 'skills'),
        path.join(home, '.gemini', 'antigravity', 'skills'),
        path.join(home, '.gemini', 'antigravity-cli', 'skills'),
        path.join(home, '.gemini', 'antigravity-ide', 'skills'),
      ];
    case 'kimi':
      return [path.join(home, '.kimi-code', 'skills')];
    case 'grok':
      return [path.join(home, '.grok', 'skills')];
    case 'opencode':
      return [path.join(home, '.config', 'opencode', 'skills')];
    default:
      return [];
  }
}

function copySkill(source: SkillSource, targetRoot: string): boolean {
  const target = path.join(targetRoot, source.name);
  if (fs.existsSync(path.join(target, 'SKILL.md'))) return false;
  fs.mkdirSync(targetRoot, { recursive: true });
  fs.cpSync(source.dir, target, {
    recursive: true,
    force: false,
    errorOnExist: false,
  });
  return true;
}

/**
 * Mirror installed skills into the namespace used by the target CLI. This is
 * intentionally best-effort and non-destructive: existing target skills win.
 */
export function ensureSkillsForCli(
  adapterId: string,
  options: SkillMirrorOptions = {},
): SkillMirrorResult {
  const home = options.home ?? os.homedir();
  const generatedRoot =
    options.generatedRoot ?? path.join(home, '.nexus', 'generated-skills');
  const sourceDirs = [
    writeGeneratedSkills(generatedRoot),
    ...(options.sourceDirs ?? defaultSourceDirs(home)),
  ];
  const sources = selectSources(
    readSkillSources(sourceDirs),
    options.allowedSkills,
  );
  const targetDirs = [
    ...cliSkillDirs(adapterId, home),
    ...(options.ephemeralHomeDir
      ? [path.join(options.ephemeralHomeDir, '.claude', 'skills')]
      : []),
  ];

  let mirrored = 0;
  for (const targetDir of targetDirs) {
    for (const source of sources) {
      if (copySkill(source, targetDir)) mirrored += 1;
    }
  }

  return { mirrored, targetDirs };
}
