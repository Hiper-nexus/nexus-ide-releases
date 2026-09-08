import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PONYTAIL_RULES } from './ponytail';
import { BUILTIN_BRIDGEMIND_SKILLS } from './bridge-mind-skills';
import { IMPECCABLE_MANIFEST } from './impeccable-manifest';
import { ARCHIFY_MANIFEST } from './archify-manifest';
import { BMAD_TEMPLATES_MANIFEST } from './bmad-templates-manifest';
import { SUPERPOWERS_MANIFEST } from './superpowers-manifest';
import { DEMBRANDT_MANIFEST } from './dembrandt-manifest';
import type { SkillAsset } from './impeccable-manifest';
import {
  copyAgentPluginSkill,
  discoverAgentPluginSkillSources,
  visibleAgentPluginReduction,
  type AgentPluginMirrorReduction,
  type AgentPluginMirrorSource,
} from './agent-plugin-skill-mirror';

const GENERATED_PONYTAIL_SKILL = `---
name: ponytail
description: Use for lean senior implementation: reuse existing code, avoid speculative abstractions, and write the smallest correct diff.
---

${PONYTAIL_RULES}
`;

/**
 * Vendored verbatim from mattpocock/skills — skills/productivity/grilling
 * (MIT, Copyright (c) 2026 Matt Pocock). See
 * third_party/licenses/mattpocock-skills-MIT.txt. Usada pelo squad de
 * planejamento: fatos vêm do código, decisões vêm do usuário, uma pergunta
 * por vez.
 */
const GENERATED_GRILLING_SKILL = `---
name: grilling
description: Grill the user relentlessly about a plan, decision, or idea. Use when the user wants to stress-test their thinking, or uses any 'grill' trigger phrases.
---

Interview me relentlessly about every aspect of this until we reach a shared understanding. Walk down each branch of the decision tree, resolving dependencies between decisions one-by-one. For each question, provide your recommended answer.

Ask the questions one at a time, waiting for feedback on each question before continuing. Asking multiple questions at once is bewildering.

If a *fact* can be found by exploring the environment (filesystem, tools, etc.), look it up rather than asking me. The *decisions*, though, are mine — put each one to me and wait for my answer.

Do not act on it until I confirm we have reached a shared understanding.
`;

/**
 * Main-owned visual path for governed workers. It intentionally avoids
 * Codex's private generated_images directory and any ambient provider key:
 * media generation stays behind the audited Nexus MCP boundary and writes
 * directly into the authorized workspace.
 */
const GENERATED_NEXUS_VISUAL_MEDIA_SKILL = `---
name: nexus-visual-media
description: Generate or edit visual assets through the governed Nexus media tools and keep every output inside the authorized workspace.
---

# Nexus visual media

Use this workflow whenever the mission requires an image, illustration,
avatar, mascot, sprite or other generated visual asset.

1. Call \`nexus_media_providers\` and use only a configured provider/model from
   its response. Never invent a provider or model.
2. Call \`nexus_image_generate\` with a precise prompt and an \`outPath\` inside
   the current workspace. Pass workspace reference images through
   \`imagePath\` or \`referenceImagePaths\` when the selected provider supports
   them.
3. Inspect the returned workspace file, compare it with the mission criteria
   and iterate deliberately. Keep intermediate and QA artifacts in a named
   workspace directory so the handoff is reproducible.
4. Submit the final workspace paths and visual QA evidence in the handoff.

Do not use native image-generation tools, \`generated_images\`, an
\`OPENAI_API_KEY\`, the Codex system \`imagegen\` skill or \`hatch-pet\`.
Those paths are outside this governed session and are not mission authority.
If no configured Nexus media provider is available, stop and report the exact
Settings → Mídia action required instead of pretending an asset was generated.
`;

const GENERATED_NEXUS_PET_STUDIO_SKILL = `---
name: nexus-pet-studio
description: Build a validated Nexus desktop-pet v2 package inside the authorized workspace using governed Nexus media and the exact bundled Pillow runtime.
---

# Nexus Pet Studio

You are the single Pet Maker for this dedicated mission. Complete the whole
visual pipeline in this session. Do not delegate.

## Authority boundary

- Use only \`nexus_media_providers\`, \`nexus_image_generate\` and
  \`load_workspace_dependencies\` for Nexus-side capabilities.
- Use the exact Python executable returned by
  \`load_workspace_dependencies\`; Pillow has already been verified there.
- Read the exact \`missionId\` from the kickoff. Work only below
  \`artifacts/nexus-pet-studio/<missionId>/<pet-id>/\` in the current
  workspace.
- Never write to \`~/.codex/pets\`. Nexus validates and installs the final
  package after your handoff.
- Never use native image generation, \`generated_images\`, \`OPENAI_API_KEY\`,
  the Codex system \`imagegen\` skill or \`hatch-pet\`.

## Canonical visual pipeline

1. Treat the authorized reference image as the identity source. Preserve
   silhouette, palette, face, proportions and distinguishing marks.
2. Call \`nexus_media_providers\`, then generate a canonical transparent base
   with \`nexus_image_generate\` into the workspace. Reuse that base as a
   reference for every later row; never mix isolated cells from unrelated
   generators.
3. Build an 8-column × 11-row sheet. The canonical cell is 192×208 px, so the
   final image is 1536×2288 px:
   - row 0: idle (6 frames; fill remaining cells consistently)
   - row 1: running right (8)
   - row 2: running left (8)
   - row 3: waving (4; fill remaining cells consistently)
   - row 4: jumping
   - row 5: failed
   - row 6: waiting (6; fill remaining cells consistently)
   - row 7: running/activity
   - row 8: review
   - row 9: look directions 000° through 157.5° in 22.5° steps
   - row 10: look directions 180° through 337.5° in 22.5° steps
4. Keep the character on one stable ground line and at one stable scale.
   Preserve transparency; reject clipping, opaque backgrounds, duplicated
   anatomy, style drift and cells whose identity no longer matches the base.
5. Assemble deterministically with Pillow. Save the final package as:
   - \`artifacts/nexus-pet-studio/<missionId>/<pet-id>/spritesheet.webp\`
   - \`artifacts/nexus-pet-studio/<missionId>/<pet-id>/pet.json\`
   The id must match the folder basename and \`[a-z0-9][a-z0-9._-]{0,63}\`.
   The manifest must contain that \`id\`, a human \`displayName\`,
   \`spriteVersionNumber: 2\` and
   \`spritesheetPath: "spritesheet.webp"\`.
6. Create QA evidence alongside the package: a contact sheet and a short
   motion preview covering idle, both running directions, wave, failure,
   waiting and look directions. Verify the final WebP dimensions, RIFF/WEBP
   header, file-size limit (2.5 MiB) and manifest JSON.
7. Submit one final \`nexus_handoff_submit\` with honest status. On success,
   include the absolute workspace paths of \`spritesheet.webp\`, \`pet.json\`
   and the QA evidence. Nexus will install only a fresh, descriptor-validated
   package from this exact workspace and session.
`;

interface SkillSource {
  name: string;
  dir: string;
  grantNames: readonly string[];
  plugin?: AgentPluginMirrorSource;
}

export interface MirroredSkill {
  /** Skill directory name, already normalized. */
  readonly name: string;
  /** Directory this copy was written into. */
  readonly targetDir: string;
}

export interface SkillMirrorResult {
  mirrored: number;
  targetDirs: string[];
  /**
   * Exactly what THIS call materialized (never what was already there).
   * Callers that write into a real, user-owned provider profile need this to
   * mark their own copies, so the delivery stays reversible.
   */
  copied: MirroredSkill[];
  /** Visible proof that package requests were reduced by main-owned policy. */
  pluginReductions: AgentPluginMirrorReduction[];
  /** Component-level degradation; other valid skills still materialize. */
  pluginFailures: Array<{ qualifiedName: string; reason: string }>;
}

export interface SkillMirrorOptions {
  home?: string;
  sourceDirs?: string[];
  generatedRoot?: string;
  allowedSkills?: string[] | null;
  /** Main-owned PreToolUse policy; package metadata can only intersect it. */
  allowedTools?: string[] | null;
  ephemeralHomeDir?: string | null;
  /**
   * Extra provider-native destinations. Governed sessions use this to copy
   * only explicitly granted skills into a private provider home.
   */
  targetDirs?: string[];
  /**
   * Direct panes keep the normal user namespace. Governed sessions set this
   * to false so mirroring cannot mutate or expose the real provider profile.
   */
  includeCliTarget?: boolean;
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
  const grillingDir = path.join(root, 'grilling');
  fs.mkdirSync(grillingDir, { recursive: true });
  fs.writeFileSync(
    path.join(grillingDir, 'SKILL.md'),
    GENERATED_GRILLING_SKILL,
  );
  const visualMediaDir = path.join(root, 'nexus-visual-media');
  fs.mkdirSync(visualMediaDir, { recursive: true });
  fs.writeFileSync(
    path.join(visualMediaDir, 'SKILL.md'),
    GENERATED_NEXUS_VISUAL_MEDIA_SKILL,
  );
  const petStudioDir = path.join(root, 'nexus-pet-studio');
  fs.mkdirSync(petStudioDir, { recursive: true });
  fs.writeFileSync(
    path.join(petStudioDir, 'SKILL.md'),
    GENERATED_NEXUS_PET_STUDIO_SKILL,
  );
  for (const skill of BUILTIN_BRIDGEMIND_SKILLS) {
    const skillDir = path.join(root, skill.name);
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), skill.body);
  }
  // Bundled multi-file skills (impeccable ~1.8 MB, archify ~600 KB).
  // Repair the Main-owned generated cache per asset: helper-only updates must
  // reach new sessions even when SKILL.md is unchanged. Provider copies remain
  // non-destructive in copySkill, preserving locally customized installations.
  materializeManifestSkill(root, 'impeccable', IMPECCABLE_MANIFEST);
  materializeManifestSkill(root, 'archify', ARCHIFY_MANIFEST);
  materializeManifestSkill(root, 'bmad-templates', BMAD_TEMPLATES_MANIFEST);
  materializeManifestSkill(root, 'superpowers', SUPERPOWERS_MANIFEST);
  materializeManifestSkill(root, 'dembrandt', DEMBRANDT_MANIFEST);
  return root;
}

function materializeManifestSkill(
  root: string,
  name: string,
  manifest: Record<string, SkillAsset>,
): void {
  for (const [relPath, asset] of Object.entries(manifest)) {
    const destPath = path.join(root, name, relPath);
    const expected = Buffer.from(asset.content, asset.encoding);
    try {
      if (fs.readFileSync(destPath).equals(expected)) continue;
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
        throw error;
      }
    }
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    fs.writeFileSync(destPath, expected);
  }
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
      if (!sources.has(name)) {
        sources.set(name, { name, dir, grantNames: Object.freeze([name]) });
      }
    }
  }
  return sources;
}

function allowedSet(
  allowedSkills: string[] | null | undefined,
): Set<string> | null {
  if (allowedSkills == null) return null;
  return new Set(allowedSkills.map(skillName).filter(Boolean));
}

function selectSources(
  sources: Map<string, SkillSource>,
  allowedSkills: string[] | null | undefined,
): SkillSource[] {
  const allowed = allowedSet(allowedSkills);
  if (allowed && allowed.size === 0) return [];
  return [...sources.values()].filter(
    (source) =>
      !allowed || source.grantNames.some((name) => allowed.has(skillName(name))),
  );
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

function addAgentPluginSources(
  sources: Map<string, SkillSource>,
  home: string,
  allowedTools: readonly string[] | null,
): void {
  for (const plugin of discoverAgentPluginSkillSources(home, allowedTools)) {
    if (sources.has(plugin.name)) continue;
    sources.set(plugin.name, {
      name: plugin.name,
      dir: plugin.dir,
      grantNames: plugin.grantNames,
      plugin,
    });
  }
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
  const available = readSkillSources(sourceDirs);
  const allowedTools = options.allowedTools === undefined ? null : options.allowedTools;
  addAgentPluginSources(available, home, allowedTools);
  const sources = selectSources(available, options.allowedSkills);
  const targetDirs = [
    ...new Set([
      ...(options.includeCliTarget === false
        ? []
        : cliSkillDirs(adapterId, home)),
      ...(options.targetDirs ?? []),
      ...(options.ephemeralHomeDir
        ? [path.join(options.ephemeralHomeDir, '.claude', 'skills')]
        : []),
    ]),
  ];

  let mirrored = 0;
  const copied: MirroredSkill[] = [];
  const pluginFailures: Array<{ qualifiedName: string; reason: string }> = [];
  const pluginReductions = sources
    .filter((source): source is SkillSource & { plugin: AgentPluginMirrorSource } =>
      source.plugin !== undefined)
    .map((source) => visibleAgentPluginReduction(source.plugin));
  for (const targetDir of targetDirs) {
    for (const source of sources) {
      let didCopy = false;
      try {
        didCopy = source.plugin
          ? copyAgentPluginSkill(source.plugin, targetDir, allowedTools)
          : copySkill(source, targetDir);
      } catch (error) {
        if (!source.plugin) throw error;
        pluginFailures.push({
          qualifiedName: source.plugin.qualifiedName,
          reason: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
      if (!didCopy) continue;
      mirrored += 1;
      copied.push({ name: source.name, targetDir });
    }
  }

  return { mirrored, targetDirs, copied, pluginReductions, pluginFailures };
}
