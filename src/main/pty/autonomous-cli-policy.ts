import type { CliPtyAdapter } from '../../shared/adapter-types';
import { isAdvisoryUnconfinedCli } from '../../shared/mission-advisory';
import {
  PET_STUDIO_SQUAD,
  PET_STUDIO_SQUAD_ID,
} from '../../shared/pet-studio';
import type { MissionPaneAuthoritySeal } from '../../shared/orch-types';
import type { SpawnAuthoritySource } from '../orch/spawn-authority';
import { snapshotSquadAuthority } from '../orch/squad-authority-snapshot';
import {
  CODEX_READ_ONLY_PERMISSION_PROFILE,
  CODEX_WORKSPACE_PERMISSION_PROFILE,
} from './codex-native-authority';

const CLAUDE_MUTATING_NATIVE_TOOLS = [
  'Task',
  'Bash',
  'Edit',
  'Write',
  'NotebookEdit',
] as const;
const CLAUDE_FAMILY_ADAPTERS = new Set(['claude', 'glm', 'glm-flash', 'longcat', 'deepseek']);

export interface NativeEffectAuthority {
  readonly source: SpawnAuthoritySource;
  readonly adapterId?: string;
  readonly role?: 'orchestrator' | 'worker' | 'user';
  readonly missionId?: string;
  readonly squadId?: string;
  readonly agentName?: string;
  readonly allowedTools?: readonly string[] | null;
  readonly allowedSkills?: readonly string[] | null;
  readonly contextRevision?: string;
  readonly authoritySeal?: MissionPaneAuthoritySeal;
  readonly readOnly?: boolean;
  /** Native CLI confinement independent from Nexus MCP delegation authority. */
  readonly nativeReadOnly?: boolean;
}

export interface AutonomousCliPolicyOptions {
  /**
   * Permit an already mission-bound orchestrator to use audited Nexus MCP
   * without a second provider prompt while native filesystem access remains
   * read-only.
   */
  readonly unattendedNexusMcp?: boolean;
  /**
   * A mission-bound worker (or the exact built-in Pet maker) is being launched
   * in its main-owned execution root. A worktree is an integration boundary,
   * not a process sandbox, so the CLI must also enforce workspace-scoped
   * native writes.
   */
  readonly enforceWorkspaceWriteSandbox?: boolean;
  /**
   * Exact `-c` values emitted by the main-owned MCP decorator. Renderer/user
   * extraArgs are intentionally excluded so they cannot register a lookalike
   * Nexus server whose out-of-process tools bypass the filesystem sandbox.
   */
  readonly trustedWorkspaceConfigOverrides?: readonly string[];
  /** Exact model selected by main for this governed process. */
  readonly trustedWorkspaceModel?: string;
  /** Exact provider resume sequence resolved from main-owned session state. */
  readonly trustedResumeArgs?: readonly string[];
  /** Exact fresh session-id sequence minted by main. */
  readonly trustedSessionArgs?: readonly string[];
  /** Exact MCP/settings argv emitted by the trusted main decoration hook. */
  readonly trustedDecorationArgs?: readonly string[];
  /** Exact private Codex permission profile compiled by main for this cwd. */
  readonly trustedCodexPermissionProfile?: string;
  /**
   * Main has bound this Codex process to the Nexus-owned physical sandbox.
   * This is intentionally trusted-only: setting it without the outer boundary
   * would remove Codex's native filesystem confinement.
   */
  readonly trustedCodexExternalProcessSandbox?: boolean;
  /**
   * Advisory-unconfined mission participant (kimi/agy/opencode read_only
   * worker): MCP read-only + outer kernel write deny is the authority boundary.
   * Provider auto-approve (yolo) is KEPT so the agent never stalls on interactive
   * TUIs; native confinement flags the CLI cannot enforce are still not invented.
   */
  readonly advisoryUnconfinedParticipation?: boolean;
  /**
   * Operator-choice writable worker. The process is already rooted in its
   * dedicated task worktree and only Main may integrate it; argv keeps the
   * provider's auto-approve mode and does not add a nested sandbox.
   */
  readonly operatorChoiceWorkspaceWrite?: boolean;
  /**
   * Default autopilot mission participant. Keep the provider's real
   * auto-approve mode for every role so an approval TUI cannot park the
   * mission. Per-session Nexus authority and the Main-owned merge still apply.
   */
  readonly operatorChoiceParticipation?: boolean;
}

function sameCanonicalCapabilityList(
  actual: readonly string[] | null | undefined,
  expected: readonly string[] | null | undefined,
): boolean {
  const canonicalActual = actual ?? null;
  const canonicalExpected = expected ?? null;
  return (
    canonicalActual === canonicalExpected ||
    (canonicalActual !== null &&
      canonicalExpected !== null &&
      canonicalActual.length === canonicalExpected.length &&
      canonicalExpected.every(
        (capability, index) => canonicalActual[index] === capability,
      ))
  );
}

const PET_STUDIO_SQUAD_REVISION_HASH =
  snapshotSquadAuthority(PET_STUDIO_SQUAD).hash;
const AUTHORITY_HASH = /^[a-f0-9]{64}$/;

function hasCanonicalPersistedPetSeal(
  authority: NativeEffectAuthority,
): boolean {
  const seal = authority.authoritySeal;
  return Boolean(
    authority.source === 'persisted-pane' &&
      authority.missionId?.trim() &&
      seal &&
      Number.isInteger(seal.intentVersion) &&
      seal.intentVersion > 0 &&
      AUTHORITY_HASH.test(seal.intentContractHash) &&
      AUTHORITY_HASH.test(seal.contractHash) &&
      seal.contextRevision.length > 0 &&
      authority.contextRevision === seal.contextRevision &&
      seal.squadRevisionHash === PET_STUDIO_SQUAD_REVISION_HASH,
  );
}

/**
 * The built-in Pet Studio is the only main-owned orchestrator that implements
 * directly in the base workspace. Immediate launch is tied to its one-shot
 * grant; persisted resume additionally requires the current main-owned pane
 * seal. An id collision or widened/trimmed capability list remains
 * delegate-only.
 */
export function isPetStudioNativeWorkspaceAuthority(
  authority: NativeEffectAuthority,
): boolean {
  const maker = PET_STUDIO_SQUAD.agents[0];
  const launchAuthority =
    (authority.source === 'legacy-squad' &&
      authority.contextRevision === undefined &&
      authority.authoritySeal === undefined) ||
    hasCanonicalPersistedPetSeal(authority);
  return Boolean(
    maker &&
      authority.readOnly !== true &&
      authority.nativeReadOnly !== true &&
      launchAuthority &&
      authority.adapterId === maker.cli &&
      authority.adapterId === 'codex' &&
      authority.role === maker.category &&
      authority.role === 'orchestrator' &&
      authority.squadId === PET_STUDIO_SQUAD_ID &&
      authority.agentName === maker.agentName &&
      sameCanonicalCapabilityList(
        authority.allowedTools,
        maker.allowedTools,
      ) &&
      sameCanonicalCapabilityList(
        authority.allowedSkills,
        maker.allowedSkills,
      ),
  );
}

/**
 * Main-owned Codex mission workers need native confinement even before a PREVC
 * exists. PREVC seals delivery semantics; it must not be the switch deciding
 * whether a provider may escape into its real home. The caller still has to
 * prove a distinct execution scope and the release-pinned Codex adapter before
 * selecting workspace-write.
 */
export function isMissionBoundCodexWorkspaceAuthority(
  authority: NativeEffectAuthority,
): boolean {
  return Boolean(
    authority.source !== 'direct-user' &&
      authority.adapterId === 'codex' &&
      authority.role === 'worker' &&
      authority.missionId?.trim() &&
      authority.readOnly !== true &&
      authority.nativeReadOnly !== true,
  );
}

/**
 * Autoridade nativa de escrita:
 * - worker Codex vinculado a missão e isolado em execution scope; PREVC não é
 *   usado como chave de confinamento;
 * - Pet Studio builtin, por um grant imediato canônico e de uso único;
 * - usuário direto, sob a escolha explícita de permissão do provider.
 *
 * Os demais orquestradores pedem confinamento nativo de leitura no checkout
 * base, mas ele só é aplicado no modo Hardened que o operador escolhe
 * (mission-cli-execution-policy); no Autopilot não há confinamento (F-1157).
 * `readOnly` só é fronteira MCP quando o Hardened o confina
 * (`readOnlyEnforced`); `nativeReadOnly` confina a CLI no mesmo modo.
 */
export function requiresReadOnlyNativeAuthority(
  authority: NativeEffectAuthority,
): boolean {
  // Advisory-unconfined lane: MCP read-only authority is the only boundary.
  // Pushing these CLIs through the governed native argv would fail closed
  // (they declare no enforceable read-only), so no native confinement is
  // claimed — the authority record stays honest (nativeReadOnly=false).
  // Claude is advisory-eligible but IS natively confined, so it stays out.
  if (
    authority.readOnly === true &&
    authority.role === 'worker' &&
    Boolean(authority.missionId?.trim()) &&
    isAdvisoryUnconfinedCli(authority.adapterId ?? '')
  ) {
    return false;
  }
  if (authority.readOnly === true || authority.nativeReadOnly === true) {
    return true;
  }
  if (isPetStudioNativeWorkspaceAuthority(authority)) return false;
  if (isMissionBoundCodexWorkspaceAuthority(authority)) return false;
  // A pane opened directly by the user follows the provider permission choice.
  if (authority.source === 'direct-user') return false;
  if (authority.role === 'orchestrator') return true;
  if (authority.source === 'legacy-squad') return true;
  return authority.role !== 'worker' || !authority.contextRevision;
}

function removeSequence(args: string[], sequence: readonly string[]): string[] {
  if (sequence.length === 0) return args;
  const result: string[] = [];
  for (let index = 0; index < args.length; ) {
    const matches = sequence.every(
      (value, offset) => args[index + offset] === value,
    );
    if (matches) {
      index += sequence.length;
      continue;
    }
    result.push(args[index]);
    index += 1;
  }
  return result;
}

function permissionSequences(adapter: CliPtyAdapter): string[][] {
  const permission = adapter.control?.permission;
  if (!permission) return [];
  const sequences = [permission.yolo, permission.safe ?? []].filter(
    (sequence) => sequence.length > 0,
  );
  if (permission.arg) {
    for (const mode of Object.values(permission.modes)) {
      if (mode) sequences.push([permission.arg, mode]);
    }
  } else {
    for (const mode of Object.values(permission.modes)) {
      const parts = mode.split(/\s+/).filter(Boolean);
      if (parts.length > 0) sequences.push(parts);
    }
  }
  return sequences.sort((left, right) => right.length - left.length);
}

function appendOnce(args: string[], sequence: readonly string[]): void {
  if (sequence.length === 0) return;
  const alreadyPresent = args.some((_, index) =>
    sequence.every((value, offset) => args[index + offset] === value),
  );
  if (!alreadyPresent) args.push(...sequence);
}

function equalsSequence(
  values: readonly string[] | undefined,
  expected: readonly string[],
): boolean {
  return (
    values?.length === expected.length &&
    expected.every((value, index) => values[index] === value)
  );
}

function declaresEnforceableReadOnly(safeArgs: readonly string[]): boolean {
  return (
    safeArgs.includes('--read-only') ||
    safeArgs.includes('--sandbox=read-only') ||
    safeArgs.some(
      (arg, index) =>
        arg === '--sandbox' && safeArgs[index + 1] === 'read-only',
    )
  );
}

/** Side-effect-free capability probe used before credential or PTY setup. */
export function supportsEnforceableReadOnlyNativeAuthority(
  adapter: CliPtyAdapter,
): boolean {
  const permission = adapter.control?.permission;
  if (adapter.id === 'codex') return true;
  if (adapter.id === 'glm' || adapter.id === 'glm-flash' || adapter.id === 'longcat' || adapter.id === 'deepseek') return false;
  return (
    (adapter.quirks?.mcpAutoload &&
      adapter.id === 'claude' &&
      permission?.arg === '--permission-mode') ||
    declaresEnforceableReadOnly(
      permission?.readOnly ?? permission?.safe ?? [],
    )
  );
}

/**
 * Release-pinned native mutation boundary for autonomous task worktrees.
 *
 * Keep this deliberately narrower than "has a flag containing sandbox".
 * Codex 0.145.0 exposes a real filesystem sandbox with a workspace-write
 * profile and a separate never-ask policy. Other installed CLIs either expose
 * no read/write boundary (Kimi/OpenCode), only terminal restrictions
 * (AGY), or have not passed the Nexus physical escape probe for their named
 * profile (Grok). Direct user panes remain available for all of them.
 *
 * Adapter origin is checked separately by adapter-registry/main spawn. This
 * structural check prevents a stale or edited builtin declaration from being
 * promoted merely because its id is "codex".
 */
export function supportsEnforceableWorkspaceWriteNativeAuthority(
  adapter: CliPtyAdapter,
): boolean {
  const permission = adapter.control?.permission;
  return (
    adapter.id === 'codex' &&
    adapter.bin === 'codex' &&
    equalsSequence(adapter.spawn.interactive, ['codex']) &&
    equalsSequence(adapter.spawn.extraArgs, []) &&
    adapter.quirks.nexusMcp === 'codex' &&
    permission?.arg === '--ask-for-approval' &&
    permission.modes.auto === 'never' &&
    permission.modes.default === 'on-request' &&
    equalsSequence(permission.safe, [
      '--sandbox',
      'workspace-write',
      '--ask-for-approval',
      'on-request',
    ]) &&
    equalsSequence(permission.yolo, [
      '--dangerously-bypass-approvals-and-sandbox',
    ])
  );
}

const CODEX_SAFE_EFFORT_OVERRIDE =
  /^model_reasoning_effort=(?:low|medium|high|xhigh)$/;
const CODEX_SAFE_MODEL = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$/;

/**
 * Reconstruct the governed Codex argv from a semantic allowlist. This handles
 * spaced, attached and equals short options uniformly and drops the `--`
 * terminator, remote execution, profiles, extra writable roots, images, web
 * search and feature toggles. Unknown argv never crosses the authority
 * boundary.
 */
function codexGovernedArgs(
  currentArgs: readonly string[],
  options: AutonomousCliPolicyOptions,
  sandbox: 'read-only' | 'workspace-write',
  approval: 'never' | 'on-request',
): string[] {
  const expectedPermissionProfile =
    sandbox === 'workspace-write'
      ? CODEX_WORKSPACE_PERMISSION_PROFILE
      : CODEX_READ_ONLY_PERMISSION_PROFILE;
  if (
    options.trustedCodexPermissionProfile !== expectedPermissionProfile
  ) {
    throw new Error(
      `governed Codex ${sandbox} requires main-owned permission profile ` +
        expectedPermissionProfile,
    );
  }
  const trustedConfigs = new Set(
    options.trustedWorkspaceConfigOverrides ?? [],
  );
  const keepConfig = (value: string): boolean =>
    CODEX_SAFE_EFFORT_OVERRIDE.test(value) || trustedConfigs.has(value);
  const safeEffortConfigs: string[] = [];
  let keepGovernedNoSubagents = false;
  const keepMainOwnedHookTrustBypass =
    options.trustedDecorationArgs?.includes(
      '--dangerously-bypass-hook-trust',
    ) === true;

  for (let index = 0; index < currentArgs.length; index += 1) {
    const arg = currentArgs[index]!;
    if (arg === '-c' || arg === '--config') {
      const value = currentArgs[index + 1];
      index += 1;
      if (value && CODEX_SAFE_EFFORT_OVERRIDE.test(value)) {
        safeEffortConfigs.push(value);
      }
      continue;
    }
    if (arg.startsWith('--config=')) {
      const value = arg.slice('--config='.length);
      if (CODEX_SAFE_EFFORT_OVERRIDE.test(value)) {
        safeEffortConfigs.push(value);
      }
      continue;
    }
    if (arg.startsWith('-c') && arg.length > 2) {
      const value = arg.slice(2).replace(/^=/, '');
      if (CODEX_SAFE_EFFORT_OVERRIDE.test(value)) {
        safeEffortConfigs.push(value);
      }
      continue;
    }
    if (
      arg === '--strict-config' &&
      currentArgs[index + 1] === '--disable' &&
      currentArgs[index + 2] === 'multi_agent'
    ) {
      keepGovernedNoSubagents = true;
      index += 2;
      continue;
    }
  }

  const args: string[] = [];
  const trustedModel = options.trustedWorkspaceModel;
  if (trustedModel && CODEX_SAFE_MODEL.test(trustedModel)) {
    args.push('--model', trustedModel);
  }
  for (const config of [
    ...new Set([
      ...safeEffortConfigs,
      ...[...trustedConfigs].filter(keepConfig),
    ]),
  ]) {
    args.push('-c', config);
  }
  if (keepGovernedNoSubagents) {
    args.push('--strict-config', '--disable', 'multi_agent');
  }
  if (keepMainOwnedHookTrustBypass) {
    // The decorator is trusted main-process code and emits this only after a
    // pinned Codex version probe. User/renderer extraArgs never enter
    // trustedDecorationArgs. Preserve the exact automation trust receipt so
    // the sealed per-session hooks actually run; all other unknown flags stay
    // dropped by the governed argv reconstruction.
    args.push('--dangerously-bypass-hook-trust');
  }
  if (options.trustedCodexExternalProcessSandbox) {
    // The Nexus outer sandbox is the only physical filesystem authority on
    // Darwin. `danger-full-access` prevents a nested Seatbelt profile. Keep
    // global approval `on-request`: Codex 0.145 auto-approves the exact Nexus
    // server through its server-scoped AppToolApproval::Approve setting, while
    // `never` + Disabled would silently approve every MCP server if strict
    // config ever drifted.
    args.push(
      '--sandbox',
      'danger-full-access',
      '--ask-for-approval',
      'on-request',
    );
  } else {
    // Without a trusted outer process boundary, keep the private
    // `default_permissions` profile active. Passing `--sandbox` here would
    // select Codex 0.145.0's legacy policy and disable that named profile.
    args.push('--ask-for-approval', approval);
  }
  const resume = options.trustedResumeArgs;
  if (
    resume?.length === 2 &&
    resume[0] === 'resume' &&
    resume[1] &&
    !resume[1].startsWith('-')
  ) {
    args.push('resume', resume[1]);
  }
  return args;
}

/**
 * Claude-family confinement uses the same provenance rule as Codex: rebuild
 * argv only from main-owned model/session/MCP state. User extraArgs, positional
 * subcommands and `--` never survive to turn the final restrictions into text.
 */
function claudeFamilyReadOnlyArgs(
  options: AutonomousCliPolicyOptions,
): string[] {
  const result: string[] = [];
  const model = options.trustedWorkspaceModel;
  if (model && CODEX_SAFE_MODEL.test(model)) {
    result.push('--model', model);
  }
  const resume = options.trustedResumeArgs;
  if (
    resume?.length === 2 &&
    resume[0] === '--resume' &&
    resume[1] &&
    !resume[1].startsWith('-')
  ) {
    result.push('--resume', resume[1]);
  }
  const session = options.trustedSessionArgs;
  if (
    session?.length === 2 &&
    session[0] === '--session-id' &&
    /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,199}$/.test(session[1] ?? '')
  ) {
    result.push('--session-id', session[1]!);
  }
  const decoration = options.trustedDecorationArgs ?? [];
  for (let index = 0; index < decoration.length; index += 1) {
    const arg = decoration[index]!;
    if (arg === '--strict-mcp-config') {
      result.push(arg);
      continue;
    }
    if (arg === '--mcp-config' || arg === '--settings') {
      const value = decoration[index + 1];
      index += 1;
      if (value && /^(?:\/|[a-zA-Z]:[\\/])/.test(value)) {
        result.push(arg, value);
      }
    }
  }
  return result;
}

function requestedFullAutoSequence(
  adapter: CliPtyAdapter,
  args: readonly string[],
): readonly string[] {
  const permission = adapter.control?.permission;
  if (!permission) return [];
  if (
    permission.yolo.length > 0 &&
    permission.yolo.every((arg) => args.includes(arg))
  ) {
    return permission.yolo;
  }
  if (!permission.arg) {
    for (const mode of ['yolo', 'bypass'] as const) {
      const value = permission.modes[mode];
      if (!value) continue;
      const parts = value.split(/\s+/).filter(Boolean);
      if (parts.length > 0 && parts.every((part) => args.includes(part))) {
        return parts;
      }
    }
    return [];
  }
  for (const mode of ['yolo', 'bypass'] as const) {
    const value = permission.modes[mode];
    if (!value) continue;
    const index = args.findIndex(
      (arg, offset) => arg === permission.arg && args[offset + 1] === value,
    );
    if (index >= 0) return [permission.arg, value];
  }
  return [];
}

function requestedModeSequence(
  adapter: CliPtyAdapter,
  args: readonly string[],
): readonly string[] {
  const permission = adapter.control?.permission;
  if (!permission) return [];
  if (permission.arg) {
    for (const value of Object.values(permission.modes)) {
      if (!value) continue;
      const index = args.findIndex(
        (arg, offset) => arg === permission.arg && args[offset + 1] === value,
      );
      if (index >= 0) return [permission.arg, value];
    }
  } else {
    for (const value of Object.values(permission.modes)) {
      if (!value) continue;
      const parts = value.split(/\s+/).filter(Boolean);
      if (parts.length > 0 && parts.every((part) => args.includes(part))) {
        return parts;
      }
    }
  }
  return [];
}

/**
 * Apply provider permission flags without silently downgrading an explicit
 * full-auto choice. Squad role/read-only metadata scopes Nexus MCP authority;
 * it must not override the permission mode the user selected for the CLI.
 */
export function secureAutonomousCliArgs(
  adapter: CliPtyAdapter,
  currentArgs: readonly string[],
  readOnly = false,
  options: AutonomousCliPolicyOptions = {},
): string[] {
  const permission = adapter.control?.permission;
  const usesNexusOnlyTools = adapter.quirks.mcpAutoload;
  const safeArgs = permission?.safe ?? [];
  const requestedFullAuto = requestedFullAutoSequence(adapter, currentArgs);
  const requestedMode = requestedModeSequence(adapter, currentArgs);

  /*
   * Read-only is an authority boundary, not a provider preference. Resolve it
   * before the writable/full-auto path and return from here so no later YOLO
   * compatibility rule can restore a bypass flag.
   */
  if (readOnly) {
    const declaresReadOnly =
      supportsEnforceableReadOnlyNativeAuthority(adapter);
    const codexConfinement = adapter.id === 'codex';
    const claudeToolConfinement =
      usesNexusOnlyTools &&
      CLAUDE_FAMILY_ADAPTERS.has(adapter.id) &&
      permission?.arg === '--permission-mode';
    if (!declaresReadOnly) {
      throw new Error(
        `adapter ${adapter.id} does not declare enforceable read-only review confinement`,
      );
    }

    let readOnlyArgs = [...currentArgs];
    for (const sequence of permissionSequences(adapter)) {
      readOnlyArgs = removeSequence(readOnlyArgs, sequence);
    }
    // The governed read-only lane prefers the adapter's dedicated,
    // probe-verified confinement sequence (e.g. grok ["--sandbox",
    // "read-only"]) over the interactive safe baseline.
    appendOnce(readOnlyArgs, permission?.readOnly ?? safeArgs);

    if (codexConfinement) {
      const automaticApprovalMode = permission?.modes.auto;
      if (
        options.unattendedNexusMcp &&
        (permission?.arg !== '--ask-for-approval' ||
          automaticApprovalMode !== 'never')
      ) {
        throw new Error(
          'Codex adapter does not declare unattended audited MCP approval',
        );
      }
      return codexGovernedArgs(
        currentArgs,
        options,
        'read-only',
        options.unattendedNexusMcp ? 'never' : 'on-request',
      );
    }

    if (claudeToolConfinement) {
      // Claude-family MCP autoload can stay unattended for Nexus reads without
      // granting any built-in filesystem/tool access. Claude treats MCP tools
      // separately from `--tools`, and their concrete names use the
      // `mcp__<server>__<tool>` form.
      readOnlyArgs = claudeFamilyReadOnlyArgs(options);
      // `dontAsk` denies anything not pre-approved instead of prompting. The
      // explicit Nexus allowlist below keeps audited reads zero-click without
      // relying on bypassPermissions.
      for (let index = 0; index < readOnlyArgs.length; ) {
        if (
          readOnlyArgs[index] === permission?.arg &&
          readOnlyArgs[index + 1] !== undefined
        ) {
          readOnlyArgs.splice(index, 2);
          continue;
        }
        index += 1;
      }
      appendOnce(readOnlyArgs, ['--permission-mode', 'dontAsk']);
      // Project/local settings may register hooks that execute before the
      // model and are outside `--tools`. The governed ephemeral HOME is the
      // only settings source allowed across this boundary.
      appendOnce(readOnlyArgs, ['--setting-sources', 'user']);
      appendOnce(readOnlyArgs, ['--tools', '']);
      appendOnce(readOnlyArgs, ['--allowedTools', 'mcp__nexus__*']);
      appendOnce(readOnlyArgs, [
        '--disallowedTools',
        ...CLAUDE_MUTATING_NATIVE_TOOLS,
      ]);
    }
    return readOnlyArgs;
  }

  if (options.enforceWorkspaceWriteSandbox) {
    if (supportsEnforceableWorkspaceWriteNativeAuthority(adapter)) {
      return codexGovernedArgs(
        currentArgs,
        options,
        'workspace-write',
        'never',
      );
    }
    if (!options.operatorChoiceWorkspaceWrite) {
      throw new Error(
        `adapter ${adapter.id} does not declare enforceable workspace-write confinement`,
      );
    }
    // Fall through to the operator-choice / advisory argv shape below.
  }

  if (
    options.advisoryUnconfinedParticipation ||
    options.operatorChoiceWorkspaceWrite ||
    options.operatorChoiceParticipation
  ) {
    // Default autopilot and hardened advisory lanes both keep provider
    // auto-approve so the agent never stalls on an "Approve once" TUI.
    // Filesystem authority is compiled by the caller: isolated worktree +
    // Main-owned merge in operator-choice, kernel/provider confinement in the
    // opt-in governed mode.
    let advisorArgs = [...currentArgs];
    for (const sequence of permissionSequences(adapter)) {
      advisorArgs = removeSequence(advisorArgs, sequence);
    }
    if ((permission?.yolo?.length ?? 0) > 0) {
      appendOnce(advisorArgs, permission!.yolo);
    }
    return advisorArgs;
  }

  if (
    !usesNexusOnlyTools &&
    safeArgs.length === 0 &&
    requestedFullAuto.length === 0 &&
    requestedMode.length === 0
  ) {
    throw new Error(
      `adapter ${adapter.id} does not declare enforceable autonomous confinement`,
    );
  }

  let args = [...currentArgs];
  for (const sequence of permissionSequences(adapter)) {
    args = removeSequence(args, sequence);
  }
  appendOnce(args, safeArgs);

  // Full-auto is a product/user setting, not a squad-role setting. Keep it for
  // workers, coordinators and reviewers alike. Previously Codex reviewers
  // lost --dangerously-bypass-approvals-and-sandbox here and stopped on every
  // MCP call even though the provider was configured as YOLO.
  if (requestedFullAuto.length > 0) {
    args = removeSequence(args, safeArgs);
    appendOnce(args, requestedFullAuto);
  } else if (requestedMode.length > 0) {
    args = removeSequence(args, safeArgs);
    appendOnce(args, requestedMode);
  }

  // Product invariant (always): Claude-family shells (claude/glm/glm-flash/
  // longcat via mcpAutoload) boot full-auto so the interactive "Yes, I accept"
  // dialog never
  // blocks a Nexus pane. Explicit plan/manual/auto/default on the *input* argv
  // stay as chosen (detect before sequences were stripped — strip drops them).
  if (usesNexusOnlyTools && permission?.yolo && permission.yolo.length > 0) {
    const modeArg = permission.arg;
    const restricted = new Set([
      'plan',
      'manual',
      'acceptEdits',
      'default',
      'dontAsk',
    ]);
    let inputRestrictedMode: string | undefined;
    if (modeArg) {
      for (let index = 0; index < currentArgs.length; index += 1) {
        const value = currentArgs[index + 1];
        if (
          currentArgs[index] === modeArg &&
          value !== undefined &&
          restricted.has(value)
        ) {
          inputRestrictedMode = value;
          break;
        }
      }
    }
    // Drop any permission-mode pair left after the sequence strip.
    if (modeArg) {
      for (let index = 0; index < args.length; ) {
        if (args[index] === modeArg && args[index + 1] !== undefined) {
          args.splice(index, 2);
          continue;
        }
        index += 1;
      }
    }
    args = removeSequence(args, safeArgs);
    args = removeSequence(args, permission.yolo);
    if (inputRestrictedMode && modeArg) {
      appendOnce(args, [modeArg, inputRestrictedMode]);
    } else {
      appendOnce(args, permission.yolo);
    }
  }

  if (usesNexusOnlyTools) {
    args.push('--allowedTools', 'mcp__nexus__*');
  }
  return args;
}
