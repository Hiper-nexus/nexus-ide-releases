import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { scanInstalledPlugins } from './agent-plugin-scan';
import {
  materializeAgentPluginSkill,
  type AgentPluginToolReduction,
} from './agent-plugin-skill';
import { removeTreeSync } from '../util/remove-tree';
import { scanComponentFiles } from './skill-threat-scan';

const MAX_SKILL_TREE_DEPTH = 16;
const MAX_SKILL_TREE_FILES = 512;
const MAX_SKILL_TREE_BYTES = 16 * 1024 * 1024;

export interface AgentPluginMirrorSource {
  readonly name: string;
  readonly grantNames: readonly string[];
  readonly qualifiedName: string;
  readonly dir: string;
  readonly rootDir: string;
  readonly reduction: AgentPluginToolReduction;
}

export interface AgentPluginMirrorReduction extends AgentPluginToolReduction {
  readonly qualifiedName: string;
  readonly providerName: string;
}

interface CopyBudget {
  files: number;
  bytes: number;
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/**
 * L7: o veredito do scan pode ter até 60 s (cache) e o plugin pode ter mudado
 * desde então. Lê pelo descritor, sem seguir link, prova que é o mesmo
 * arquivo inspecionado agora e devolve os bytes que serão escaneados E
 * gravados — nunca um caminho que muda entre o scan e a cópia.
 */
function readInspectedFile(realSource: string, inspected: fs.Stats, relative: string): Buffer {
  const fd = fs.openSync(
    realSource,
    fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0),
  );
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.dev !== inspected.dev || opened.ino !== inspected.ino) {
      throw new Error(`skill mudou durante a cópia: ${relative}`);
    }
    const bytes = fs.readFileSync(fd);
    if (bytes.length !== inspected.size) {
      throw new Error(`skill mudou durante a cópia: ${relative}`);
    }
    return bytes;
  } finally {
    fs.closeSync(fd);
  }
}

function copyContainedTree(input: {
  source: string;
  target: string;
  rootDir: string;
  providerName: string;
  allowedTools: readonly string[] | null;
  relative: string;
  depth: number;
  budget: CopyBudget;
}): void {
  if (input.depth > MAX_SKILL_TREE_DEPTH) {
    throw new Error(`skill excede profundidade máxima de ${MAX_SKILL_TREE_DEPTH}`);
  }
  const stat = fs.lstatSync(input.source);
  if (stat.isSymbolicLink()) {
    throw new Error(`skill contém link simbólico não confiável: ${input.relative}`);
  }
  const realSource = fs.realpathSync(input.source);
  if (!isInside(input.rootDir, realSource)) {
    throw new Error(`skill resolve fora da raiz do plugin: ${input.relative}`);
  }
  if (stat.isDirectory()) {
    fs.mkdirSync(input.target, { recursive: false, mode: 0o700 });
    for (const child of fs.readdirSync(realSource)) {
      copyContainedTree({
        ...input,
        source: path.join(realSource, child),
        target: path.join(input.target, child),
        relative: input.relative ? path.join(input.relative, child) : child,
        depth: input.depth + 1,
      });
    }
    return;
  }
  if (!stat.isFile()) {
    throw new Error(`skill contém entrada não regular: ${input.relative}`);
  }
  input.budget.files += 1;
  input.budget.bytes += stat.size;
  if (input.budget.files > MAX_SKILL_TREE_FILES) {
    throw new Error(`skill excede ${MAX_SKILL_TREE_FILES} arquivos`);
  }
  if (input.budget.bytes > MAX_SKILL_TREE_BYTES) {
    throw new Error(`skill excede ${MAX_SKILL_TREE_BYTES} bytes`);
  }
  const bytes = readInspectedFile(realSource, stat, input.relative);
  const threat = scanComponentFiles([{ name: input.relative, buffer: bytes }]);
  if (threat.blocked) {
    throw new Error(`conteúdo hostil em ${threat.blockReason ?? input.relative}`);
  }
  if (input.relative === 'SKILL.md') {
    const materialized = materializeAgentPluginSkill(
      bytes.toString('utf8'),
      { providerName: input.providerName, allowedTools: input.allowedTools },
    );
    fs.writeFileSync(input.target, materialized.content, { mode: 0o600 });
    return;
  }
  fs.writeFileSync(input.target, bytes, { flag: 'wx', mode: 0o600 });
  fs.chmodSync(input.target, stat.mode & 0o755);
}

export function discoverAgentPluginSkillSources(
  home: string,
  allowedTools: readonly string[] | null,
): readonly AgentPluginMirrorSource[] {
  const sources: AgentPluginMirrorSource[] = [];
  const seen = new Set<string>();
  for (const plugin of scanInstalledPlugins(home, { allowedTools })) {
    if (!plugin.rootDir || plugin.status === 'rejected' || plugin.status === 'quarantined') {
      continue;
    }
    for (const skill of plugin.skills) {
      if (seen.has(skill.providerName)) continue;
      seen.add(skill.providerName);
      sources.push(Object.freeze({
        name: skill.providerName,
        grantNames: Object.freeze([skill.qualifiedName, skill.providerName]),
        qualifiedName: skill.qualifiedName,
        dir: skill.directory,
        rootDir: plugin.rootDir,
        reduction: skill.toolReduction,
      }));
    }
  }
  return Object.freeze(sources);
}

export function copyAgentPluginSkill(
  source: AgentPluginMirrorSource,
  targetRoot: string,
  allowedTools: readonly string[] | null,
): boolean {
  const target = path.join(targetRoot, source.name);
  if (fs.existsSync(path.join(target, 'SKILL.md'))) return false;
  fs.mkdirSync(targetRoot, { recursive: true });
  const temporary = path.join(
    targetRoot,
    `.${source.name}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    copyContainedTree({
      source: source.dir,
      target: temporary,
      rootDir: source.rootDir,
      providerName: source.name,
      allowedTools,
      relative: '',
      depth: 0,
      budget: { files: 0, bytes: 0 },
    });
    fs.renameSync(temporary, target);
    return true;
  } catch (error) {
    removeTreeSync(temporary, { recursive: true, force: true });
    throw error;
  }
}

export function visibleAgentPluginReduction(
  source: AgentPluginMirrorSource,
): AgentPluginMirrorReduction {
  return Object.freeze({
    qualifiedName: source.qualifiedName,
    providerName: source.name,
    ...source.reduction,
  });
}
