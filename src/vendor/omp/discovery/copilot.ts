/**
 * Derivado de oh-my-pi (omp) — packages/coding-agent/src/discovery/github.ts
 * https://github.com/can1357/oh-my-pi @ 03c48d073bd4849726cc14750b5aecfa310bdf26 (MIT)
 * Copyright (c) 2025 Mario Zechner; (c) 2025-2026 Can Bölük — ver NOTICE.
 *
 * Provider GitHub Copilot — prioridade 30.
 * Adaptação NexusIDE (escopo v1): copilot-instructions.md (projeto + user via
 * COPILOT_HOME), *.instructions.md como rules, skills .github/skills e
 * prompts *.prompt.md como slash commands. COPILOT_CUSTOM_INSTRUCTIONS_DIRS
 * (diretórios arbitrários) fica fora da v1 — varredura é workspace + home.
 */
import path from 'node:path';
import { scanCommandsFromDir, scanSkillsFromDir } from './helpers';
import {
  emptyProviderResult,
  type DiscoveryContext,
  type ProviderResult,
} from './types';

const SOURCE = 'copilot' as const;

/** ~/.copilot, relocável via COPILOT_HOME (paridade omp resolveCopilotHome). */
function resolveCopilotHome(ctx: DiscoveryContext): string {
  const override = ctx.env.COPILOT_HOME?.trim();
  return override ? override : path.join(ctx.home, '.copilot');
}

export function loadCopilot(ctx: DiscoveryContext): ProviderResult {
  const result = emptyProviderResult();
  const githubDir = path.join(ctx.workspaceRoot, '.github');

  // ── Context files (copilot-instructions.md) ──────────────────────────────
  const projectInstructions = path.join(githubDir, 'copilot-instructions.md');
  if (ctx.io.fileExists(projectInstructions)) {
    result.contextFiles.push({
      source: SOURCE,
      level: 'project',
      path: projectInstructions,
      name: 'copilot-instructions.md',
      kind: 'context',
    });
  }
  const userInstructions = path.join(
    resolveCopilotHome(ctx),
    'copilot-instructions.md',
  );
  if (ctx.io.fileExists(userInstructions)) {
    result.contextFiles.push({
      source: SOURCE,
      level: 'user',
      path: userInstructions,
      name: 'copilot-instructions.md',
      kind: 'context',
    });
  }

  // ── Rules (*.instructions.md sob .github/instructions/, recursivo) ───────
  for (const filePath of ctx.io.walkFiles(
    path.join(githubDir, 'instructions'),
    { extensions: ['md'], recursive: true },
  )) {
    if (!filePath.endsWith('.instructions.md')) continue;
    result.contextFiles.push({
      source: SOURCE,
      level: 'project',
      path: filePath,
      name: path.basename(filePath),
      kind: 'rule',
    });
  }

  // ── Skills (.github/skills/*/SKILL.md — description obrigatória) ─────────
  const scanned = scanSkillsFromDir(
    ctx.io,
    path.join(githubDir, 'skills'),
    { source: SOURCE, level: 'project' },
    { requireDescription: true },
  );
  result.skills.push(...scanned.skills);
  result.warnings.push(...scanned.warnings);

  // ── Prompts (*.prompt.md em .github/prompts/) como slash commands ────────
  result.commands.push(
    ...scanCommandsFromDir(
      ctx.io,
      path.join(githubDir, 'prompts'),
      { source: SOURCE, level: 'project' },
      { recursive: false, suffix: '.prompt.md' },
    ),
  );

  return result;
}
