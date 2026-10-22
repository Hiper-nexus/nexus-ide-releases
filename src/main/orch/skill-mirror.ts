import { createHash } from 'node:crypto';
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
import { TYPESAFE_AI_MANIFEST } from './typesafe-ai-manifest';
import { UI_KIT_MANIFEST } from './ui-kit-manifest';
import { OC_PILOT_MANIFEST } from './oc-pilot-manifest';
import { OC_BUILDER_MANIFEST } from './oc-builder-manifest';
import { OC_SCOUT_MANIFEST } from './oc-scout-manifest';
import { OC_CONVEYOR_MANIFEST } from './oc-conveyor-manifest';
import { STACK_ADVISOR_MANIFEST } from './stack-advisor-manifest';
import { NEXUS_VIDEO_MANIFEST } from './nexus-video-manifest';
import { hasJevCredential } from '../jev/jev-secrets';
import { isVideoStudioEnabled } from '../video/video-studio-flag';
import { mimoNativePaths } from '../adapters/mimo-auth';
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
description: "Use for lean senior implementation: reuse existing code, avoid speculative abstractions, and write the smallest correct diff."
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
   its response (\`hasKey: true\`). Never invent a provider or model.
2. Choose the model from that response, not from memory:
   - If the user or the brief names a model or provider, use it.
   - Images: \`imageCostUsd\` is the list price per image of each model. Only
     \`replicate-image\` (Seedream) takes \`referenceImagePaths\`; the others
     take a single \`imagePath\` to edit.
   - Video clips, when \`nexus_video_generate\` is among your tools: each model
     in \`videoModels\` lists \`durationsSeconds\` (\`null\` = the model picks the
     length, so send no \`durationSeconds\`), \`resolutions\` and \`aspectRatios\`
     (\`[]\` = do not send that field), \`requiresImage\`, \`price\` and
     \`retiresOn\`/\`retired\`. Pick a model whose fields fit the brief and never
     a retired one. Cost = seconds × the per-second price at the resolution,
     or the per-video price; \`billedByTokensUsdPerMillion\` means the bill
     comes from tokens and the per-second price is an approximation.
   - \`defaults\` shows what runs with no provider and no model: the lowest
     list price among the connected services. Prices are list prices, not
     quality: the Nexus has not measured one model against another, so do not
     claim that one is better.
3. Call \`nexus_image_generate\` (or \`nexus_video_generate\`) with a precise
   prompt and an \`outPath\` inside the current workspace. Pass workspace
   reference images through \`imagePath\` or \`referenceImagePaths\` when the
   selected model supports them.
4. Inspect the returned workspace file, compare it with the mission criteria
   and iterate deliberately. Keep intermediate and QA artifacts in a named
   workspace directory so the handoff is reproducible.
5. Submit the final workspace paths, the provider/model you chose and why,
   the \`estimatedCostUsd\` of each generation and the visual QA evidence in
   the handoff.

Do not use native image-generation tools, \`generated_images\`, an
\`OPENAI_API_KEY\`, the Codex system \`imagegen\` skill or \`hatch-pet\`.
Those paths are outside this governed session and are not mission authority.
If no configured Nexus media provider is available, stop and report the exact
Ajustes → Serviços de mídia action required instead of pretending an asset
was generated.
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
  /**
   * Gate on sources that resolve to the generated (bundled) root — a skill
   * the user installed themselves in ~/.agents/skills etc. is never filtered.
   * Default drops bundled `typesafe-ai` when no TypeSafe credential exists.
   */
  bundledSkillFilter?: (name: string) => boolean;
}

/**
 * Bundled skills that depend on something outside the skill itself: the
 * TypeSafe credential (typesafe-ai) and the video studio internal key
 * (nexus-video). An unavailable skill is neither mirrored nor suggested.
 */
export function isBundledSkillAvailable(name: string): boolean {
  if (name === 'typesafe-ai') return hasJevCredential();
  if (name === 'nexus-video') return isVideoStudioEnabled();
  return true;
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
    path.join(mimoNativePaths(home).config, 'skills'),
  ];
}

/**
 * Skills shipped inside the app as generated TypeScript manifests. Keyed by
 * directory name, because that is what resolves both the Main-owned cache and
 * the provider copies installed from it.
 */
export const BUNDLED_MANIFESTS: Record<string, Record<string, SkillAsset>> = {
  impeccable: IMPECCABLE_MANIFEST,
  archify: ARCHIFY_MANIFEST,
  'bmad-templates': BMAD_TEMPLATES_MANIFEST,
  superpowers: SUPERPOWERS_MANIFEST,
  dembrandt: DEMBRANDT_MANIFEST,
  'typesafe-ai': TYPESAFE_AI_MANIFEST,
  'ui-kit': UI_KIT_MANIFEST,
  'oc-pilot': OC_PILOT_MANIFEST,
  'oc-builder': OC_BUILDER_MANIFEST,
  'oc-scout': OC_SCOUT_MANIFEST,
  'oc-conveyor': OC_CONVEYOR_MANIFEST,
  'stack-advisor': STACK_ADVISOR_MANIFEST,
  'nexus-video': NEXUS_VIDEO_MANIFEST,
};

/**
 * SKILL.md bodies written inline by this module (not manifest assets):
 * the generated root materializes every one of them, so they belong to the
 * same bundled catalog as BUNDLED_MANIFESTS.
 */
export const GENERATED_INLINE_SKILL_BODIES: Record<string, string> = {
  ponytail: GENERATED_PONYTAIL_SKILL,
  grilling: GENERATED_GRILLING_SKILL,
  'nexus-visual-media': GENERATED_NEXUS_VISUAL_MEDIA_SKILL,
  'nexus-pet-studio': GENERATED_NEXUS_PET_STUDIO_SKILL,
  ...Object.fromEntries(
    BUILTIN_BRIDGEMIND_SKILLS.map((skill) => [skill.name, skill.body]),
  ),
};

const MANAGED_LEDGER_FILE = '.nexus-managed.json';
const MANAGED_LEDGER_SCHEMA = 1;
/** Provider files above this size are not worth reading to identify a copy. */
const DELIVERY_PROBE_MAX_BYTES = 32 * 1024;
/** Cap on how many carried-over assets are compared before giving up. */
const DELIVERY_PROBE_LIMIT = 16;

/**
 * What Nexus itself delivered into a skill directory, as
 * `<skill> → <relative path> → sha256 of the bytes we wrote`. It is the only
 * authority that authorizes a delete: a path absent from it is never removed,
 * no matter how stale it looks.
 */
interface ManagedLedger {
  schemaVersion: number;
  skills: Record<string, Record<string, string>>;
}

function emptyLedger(): ManagedLedger {
  return { schemaVersion: MANAGED_LEDGER_SCHEMA, skills: {} };
}

function sha256Hex(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

function assetBytes(asset: SkillAsset): Buffer {
  return Buffer.from(asset.content, asset.encoding);
}

/**
 * Build-time metadata the Main bundle attaches to offloaded manifests (see
 * skill-manifest-offload): with it an asset is identified without its bytes.
 */
interface AssetBuildDigest {
  readonly sha256?: unknown;
  readonly size?: unknown;
}

function buildDigestOf(asset: SkillAsset): { sha256: string; size: number } | null {
  const meta = asset as SkillAsset & AssetBuildDigest;
  return typeof meta.sha256 === 'string' && typeof meta.size === 'number'
    ? { sha256: meta.sha256, size: meta.size }
    : null;
}

/**
 * sha256 of each bundled asset, computed once per process. Manifests are
 * module constants, so an asset object keeps its identity for the whole run.
 */
const assetDigests = new WeakMap<SkillAsset, string>();

function assetDigest(asset: SkillAsset): string {
  let digest = assetDigests.get(asset);
  if (digest === undefined) {
    digest = buildDigestOf(asset)?.sha256 ?? sha256Hex(assetBytes(asset));
    assetDigests.set(asset, digest);
  }
  return digest;
}

/** True when the file already holds exactly the bytes of `asset`. */
function fileHoldsAsset(
  file: string,
  stat: fs.Stats,
  asset: SkillAsset,
  digest: string,
): boolean {
  const build = buildDigestOf(asset);
  if (build) {
    // Offloaded manifest: prove an unchanged file against the build-time
    // digest instead of pulling megabytes of payload into memory.
    return stat.size === build.size && sha256Hex(fs.readFileSync(file)) === digest;
  }
  const expected = assetBytes(asset);
  // Size first: a mismatch costs one stat instead of a full read.
  return stat.size === expected.length && fs.readFileSync(file).equals(expected);
}

interface VerifiedFile {
  readonly digest: string;
  readonly size: number;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
  readonly ino: number;
}

/**
 * Files this process already proved byte-identical to a bundled asset.
 * ensureSkillsForCli runs on every agent spawn, and re-decoding, re-reading
 * and re-comparing ~17 MB of bundled assets each time blocked the Main thread
 * for ~40 ms per spawn. A file whose size, mtime, ctime and inode still match
 * what was recorded after writing or verifying it is trusted; any change falls
 * back to the full byte comparison, so a tampered or stale copy is repaired.
 */
const verifiedFiles = new Map<string, VerifiedFile>();
/** Fresh overlays add new paths on every spawn; keep the memo bounded. */
const MAX_VERIFIED_FILES = 8_192;

function statIfPresent(file: string): fs.Stats | null {
  try {
    return fs.statSync(file);
  } catch (error) {
    if (isMissingError(error)) return null;
    throw error;
  }
}

function isVerified(file: string, digest: string, stat: fs.Stats): boolean {
  const known = verifiedFiles.get(file);
  return (
    known !== undefined &&
    known.digest === digest &&
    known.size === stat.size &&
    known.mtimeMs === stat.mtimeMs &&
    known.ctimeMs === stat.ctimeMs &&
    known.ino === stat.ino
  );
}

function recordVerified(file: string, digest: string, stat: fs.Stats): void {
  verifiedFiles.delete(file);
  if (verifiedFiles.size >= MAX_VERIFIED_FILES) {
    const oldest = verifiedFiles.keys().next().value;
    if (oldest !== undefined) verifiedFiles.delete(oldest);
  }
  verifiedFiles.set(file, {
    digest,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs,
    ino: stat.ino,
  });
}

/** A verified copy of `digest` at `file`, usable as a copy-on-write source. */
function verifiedSource(file: string | undefined, digest: string): string | null {
  if (file === undefined) return null;
  const stat = statIfPresent(file);
  return stat && isVerified(file, digest, stat) ? file : null;
}

/** Test-only: forget what this process verified on disk. */
export function __resetSkillMirrorCachesForTests(): void {
  verifiedFiles.clear();
}

function isMissingError(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}

function readManagedLedger(generatedRoot: string): ManagedLedger {
  const file = path.join(generatedRoot, MANAGED_LEDGER_FILE);
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return emptyLedger();
    const raw = (parsed as { skills?: unknown }).skills;
    if (!raw || typeof raw !== 'object') return emptyLedger();
    const skills: Record<string, Record<string, string>> = {};
    for (const [name, entries] of Object.entries(raw as Record<string, unknown>)) {
      if (!entries || typeof entries !== 'object') continue;
      const paths: Record<string, string> = {};
      for (const [relPath, digest] of Object.entries(
        entries as Record<string, unknown>,
      )) {
        if (typeof digest === 'string') paths[relPath] = digest;
      }
      skills[skillName(name)] = paths;
    }
    return { schemaVersion: MANAGED_LEDGER_SCHEMA, skills };
  } catch {
    // An absent or corrupt ledger must never authorize deletions. Starting
    // empty means this run only records what it writes from now on.
    return emptyLedger();
  }
}

function writeManagedLedger(
  generatedRoot: string,
  ledger: ManagedLedger,
): void {
  const file = path.join(generatedRoot, MANAGED_LEDGER_FILE);
  const serialized = `${JSON.stringify(ledger, null, 2)}\n`;
  try {
    // It runs on every agent spawn; only a real change may touch the disk.
    if (fs.readFileSync(file, 'utf8') === serialized) return;
  } catch (error) {
    if (!isMissingError(error)) throw error;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, serialized);
}

/** Manifest keys use POSIX separators on every platform. */
function toManifestKey(root: string, abs: string): string {
  return path.relative(root, abs).split(path.sep).join('/');
}

/**
 * Makes `destPath` hold exactly `asset`. `cloneFrom` names a copy this
 * process already verified (the Main-owned generated root): a missing file is
 * then cloned from it (copy-on-write on APFS/Btrfs) instead of decoding and
 * writing the bytes again.
 */
function placeSkillAsset(
  destPath: string,
  asset: SkillAsset,
  cloneFrom?: string,
): boolean {
  const digest = assetDigest(asset);
  const before = statIfPresent(destPath);
  let changed = false;
  if (before === null) {
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    const source = verifiedSource(cloneFrom, digest);
    if (source) {
      fs.copyFileSync(source, destPath, fs.constants.COPYFILE_FICLONE);
    } else {
      fs.writeFileSync(destPath, assetBytes(asset));
    }
    changed = true;
  } else if (
    !isVerified(destPath, digest, before) &&
    !fileHoldsAsset(destPath, before, asset, digest)
  ) {
    fs.writeFileSync(destPath, assetBytes(asset));
    changed = true;
  }
  let stat = before !== null && !changed ? before : fs.statSync(destPath);
  // Matching bytes do not prove the mode is right: releases before this one
  // wrote the vendored CLI 0644, and bailing out on "unchanged content" would
  // perpetuate that broken cache forever.
  if (asset.executable && process.platform !== 'win32') {
    if ((stat.mode & 0o111) === 0) {
      fs.chmodSync(destPath, 0o755);
      changed = true;
      stat = fs.statSync(destPath);
    }
  }
  recordVerified(destPath, digest, stat);
  return changed;
}

/**
 * Removes everything under a Main-owned skill directory that the current
 * bundle no longer ships. Safe because nothing but Nexus ever writes there.
 */
function pruneManifestDir(
  skillRoot: string,
  dir: string,
  kept: ReadonlySet<string>,
): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    if (isMissingError(error)) return;
    throw error;
  }
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      pruneManifestDir(skillRoot, abs, kept);
      continue;
    }
    if (kept.has(toManifestKey(skillRoot, abs))) continue;
    fs.rmSync(abs, { force: true });
  }
  if (dir === skillRoot) return;
  try {
    if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
  } catch (error) {
    if (!isMissingError(error)) throw error;
  }
}

/** Deletes only when the bytes are still exactly what we delivered. */
function removeIfUnmodified(abs: string, digest: string): boolean {
  let current: Buffer;
  try {
    current = fs.readFileSync(abs);
  } catch (error) {
    if (isMissingError(error)) return true;
    throw error;
  }
  if (sha256Hex(current) !== digest) return false;
  fs.rmSync(abs, { force: true });
  return true;
}

/**
 * True when a provider directory already holds one of our bundled files
 * byte-for-byte. That is what separates "an older Nexus installed this" from
 * "the user wrote this skill themselves" when no ledger exists yet — installs
 * predating the ledger carry over their untouched assets verbatim.
 */
function looksLikeBundledDelivery(
  target: string,
  manifest: Record<string, SkillAsset>,
): boolean {
  const probes = Object.entries(manifest)
    // The build-time size keeps offloaded (large) assets out of the probe set
    // without reading their payload.
    .filter(([, asset]) =>
      (buildDigestOf(asset)?.size ?? asset.content.length) <= DELIVERY_PROBE_MAX_BYTES)
    .sort((a, b) => a[1].content.length - b[1].content.length)
    .slice(0, DELIVERY_PROBE_LIMIT);
  for (const [relPath, asset] of probes) {
    const abs = path.join(target, relPath);
    let size: number;
    try {
      size = fs.statSync(abs).size;
    } catch (error) {
      if (!isMissingError(error)) throw error;
      continue;
    }
    const expected = Buffer.from(asset.content, asset.encoding);
    // Size first: a mismatch costs one stat instead of a full read.
    if (size !== expected.length) continue;
    if (fs.readFileSync(abs).equals(expected)) return true;
  }
  return false;
}

/**
 * Removes directories left empty by a sync. Deliberately separate from
 * pruneManifestDir: this one never considers files, so it cannot be misused
 * with an empty keep-set to wipe a directory.
 */
function pruneEmptyDirs(dir: string, stopAt: string): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    if (isMissingError(error)) return;
    throw error;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) pruneEmptyDirs(path.join(dir, entry.name), stopAt);
  }
  if (dir === stopAt) return;
  try {
    if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
  } catch (error) {
    if (!isMissingError(error)) throw error;
  }
}

interface BundledInstall {
  /** False when the target is somebody else's skill and must not be touched. */
  applied: boolean;
  /** True when this call actually changed bytes on disk. */
  changed: boolean;
  /** Paths this delivery now owns inside the target. */
  managed: Record<string, string>;
}

/**
 * Installs or refreshes one bundled skill into a provider directory.
 *
 * A skill the user authored, or one they have taken over, is left alone; a
 * copy traceable to Nexus is brought up to the shipped version. Deletion is
 * fenced by the ledger plus a digest, so an edited file is never lost.
 */
function installBundledSkill(
  targetRoot: string,
  name: string,
  manifest: Record<string, SkillAsset>,
  ledger: ManagedLedger,
  cloneRoot?: string,
): BundledInstall {
  const target = path.join(targetRoot, name);
  const recorded = ledger.skills[skillName(name)] ?? {};
  const tracked = Object.keys(recorded).length > 0;
  const installed = fs.existsSync(path.join(target, 'SKILL.md'));
  if (installed && !tracked && !looksLikeBundledDelivery(target, manifest)) {
    return { applied: false, changed: false, managed: recorded };
  }

  fs.mkdirSync(target, { recursive: true });
  let changed = false;
  const managed: Record<string, string> = {};
  for (const [relPath, asset] of Object.entries(manifest)) {
    const cloneFrom = cloneRoot === undefined ? undefined : path.join(cloneRoot, relPath);
    changed = placeSkillAsset(path.join(target, relPath), asset, cloneFrom) || changed;
    managed[relPath] = assetDigest(asset);
  }
  for (const [relPath, digest] of Object.entries(recorded)) {
    if (relPath in managed) continue;
    if (!removeIfUnmodified(path.join(target, relPath), digest)) {
      // Still ours, just not removable while the user's edit sits in it.
      managed[relPath] = digest;
      continue;
    }
    changed = true;
  }
  pruneEmptyDirs(target, target);
  return { applied: true, changed, managed };
}

/** Inline SKILL.md bodies as assets, so they share the verified-file memo. */
const inlineSkillAssets = new Map<string, SkillAsset>();

function writeInlineSkill(root: string, name: string, body: string): void {
  let asset = inlineSkillAssets.get(body);
  if (!asset) {
    asset = { content: body, encoding: 'utf8' };
    inlineSkillAssets.set(body, asset);
  }
  placeSkillAsset(path.join(root, name, 'SKILL.md'), asset);
}

function writeGeneratedSkills(root: string): string {
  writeInlineSkill(root, 'ponytail', GENERATED_PONYTAIL_SKILL);
  writeInlineSkill(root, 'grilling', GENERATED_GRILLING_SKILL);
  writeInlineSkill(root, 'nexus-visual-media', GENERATED_NEXUS_VISUAL_MEDIA_SKILL);
  writeInlineSkill(root, 'nexus-pet-studio', GENERATED_NEXUS_PET_STUDIO_SKILL);
  for (const skill of BUILTIN_BRIDGEMIND_SKILLS) {
    writeInlineSkill(root, skill.name, skill.body);
  }
  // Bundled multi-file skills (impeccable, archify, ...). Repair the
  // Main-owned generated cache asset by asset: helper-only updates must reach
  // new sessions even when SKILL.md is unchanged, and files a previous bundle
  // dropped must not survive into a fresh provider install.
  for (const [name, manifest] of Object.entries(BUNDLED_MANIFESTS)) {
    materializeManifestSkill(root, name, manifest);
  }
  return root;
}

function materializeManifestSkill(
  root: string,
  name: string,
  manifest: Record<string, SkillAsset>,
): void {
  const skillRoot = path.join(root, name);
  for (const [relPath, asset] of Object.entries(manifest)) {
    placeSkillAsset(path.join(skillRoot, relPath), asset);
  }
  pruneManifestDir(skillRoot, skillRoot, new Set(Object.keys(manifest)));
}

/**
 * Directory of a skill Nexus ships, freshly materialized in the Main-owned
 * generated root. `null` when the name is not in the bundle — the packaged
 * app has no loose skill folder to copy from, only these manifests.
 */
export function bundledSkillSourceDir(
  name: string,
  generatedRoot = path.join(os.homedir(), '.nexus', 'generated-skills'),
): string | null {
  if (!(name in BUNDLED_MANIFESTS) && !(name in GENERATED_INLINE_SKILL_BODIES)) {
    return null;
  }
  const dir = path.join(writeGeneratedSkills(generatedRoot), name);
  return fs.existsSync(path.join(dir, 'SKILL.md')) ? dir : null;
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
    case 'glm-flash':
    case 'longcat':
    case 'deepseek':
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
    case 'mimo-code':
      return [path.join(mimoNativePaths(home).config, 'skills')];
    default:
      return [];
  }
}

/**
 * The shipped manifest for a source, when that source is the Main-owned cache
 * of a bundled skill. Skills the user installed themselves have none, and keep
 * the non-destructive copy below.
 */
function bundledManifestFor(
  source: SkillSource,
  generatedRoot: string,
): Record<string, SkillAsset> | undefined {
  if (source.plugin) return undefined;
  const rel = path.relative(generatedRoot, source.dir);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return undefined;
  return BUNDLED_MANIFESTS[skillName(source.name)];
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
  const generatedDir = writeGeneratedSkills(generatedRoot);
  const available = readSkillSources(
    options.sourceDirs ?? defaultSourceDirs(home),
  );
  // Bundled (raiz gerada) tem precedência sobre a cópia do usuário — exceto
  // quando o filtro o derruba (typesafe-ai sem credencial TypeSafe, nexus-video
  // com o estúdio desligado);
  // nesse caso a cópia do próprio usuário continua valendo e nunca é tocada.
  const bundledSkillFilter = options.bundledSkillFilter ?? isBundledSkillAvailable;
  for (const [name, source] of readSkillSources([generatedDir])) {
    if (
      bundledManifestFor(source, generatedRoot) === undefined ||
      bundledSkillFilter(name)
    ) {
      available.set(name, source);
    }
  }
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
  // Read once for the whole run, write once at the end: the ledger describes
  // what Nexus owns across every target it delivers into.
  let ledger = readManagedLedger(generatedRoot);
  for (const targetDir of targetDirs) {
    for (const source of sources) {
      let didCopy = false;
      try {
        if (source.plugin) {
          didCopy = copyAgentPluginSkill(source.plugin, targetDir, allowedTools);
        } else {
          const manifest = bundledManifestFor(source, generatedRoot);
          if (!manifest) {
            didCopy = copySkill(source, targetDir);
          } else {
            const install = installBundledSkill(
              targetDir,
              source.name,
              manifest,
              ledger,
              source.dir,
            );
            if (install.applied) {
              ledger = {
                ...ledger,
                skills: { ...ledger.skills, [skillName(source.name)]: install.managed },
              };
            }
            didCopy = install.changed;
          }
        }
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

  writeManagedLedger(generatedRoot, ledger);
  return { mirrored, targetDirs, copied, pluginReductions, pluginFailures };
}
