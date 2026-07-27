import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import type { DarwinTrustedExecutableSeal } from "./trusted-native-cli-binary";

export const DARWIN_PTY_SUPERVISOR_NAME = "nexus-pty-supervisor";
export const DARWIN_PTY_SUPERVISOR_IDENTIFIER = "nexus-pty-supervisor";
export const DARWIN_PTY_PROVIDER_PROBE_MODE = "provider-probe";
export const DARWIN_PTY_PROVIDER_PROBE_RECEIPT =
  "NEXUS_PTY_AUTHENTICATED_PROVIDER_PROBE_V1";
export const DARWIN_PTY_PACKAGED_SMOKE_TRUST_PROFILE =
  "packaged-smoke" as const;
export const NEXUS_APP_BUNDLE_IDENTIFIER = "com.nexuside.app";
export const NEXUS_UTILITY_HELPER_IDENTIFIER = "com.nexuside.app.helper";
export const NEXUS_APPLE_TEAM_ID = "35P5XL3JN6";
const NEXUS_UTILITY_HELPER_BUNDLE_NAME = "NexusIDE Helper.app";
const NEXUS_UTILITY_HELPER_EXECUTABLE_NAME = "NexusIDE Helper";
const NEXUS_MAIN_EXECUTABLE_NAME = "nexus-ide";

export interface DarwinPtySupervisorRuntime {
  readonly platform: NodeJS.Platform;
  readonly packaged: boolean;
  readonly trustProfile?: typeof DARWIN_PTY_PACKAGED_SMOKE_TRUST_PROFILE;
  readonly resourcesPath?: string;
  readonly cwd: string;
  readonly moduleDir: string;
}

export interface SupervisedPtyCommand {
  readonly file: string;
  readonly args: string[];
}

const SYSTEM_SEATBELT_EXECUTABLE = "/usr/bin/sandbox-exec";
const SYSTEM_PERL_EXECUTABLE = "/usr/bin/perl";
const SIGNING_IDENTIFIER_PATTERN = /^[A-Za-z0-9._-]+$/;
const TEAM_IDENTIFIER_PATTERN = /^[A-Z0-9]{10}$/;
const CDHASH_PATTERN = /^[a-f0-9]{40}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const VERSION_PROBE_TIMEOUT_SECONDS = 2;

interface DarwinPtySupervisorSeal {
  readonly executablePath: string;
  readonly identifier: string;
  readonly teamIdentifier: string | null;
  readonly cdHash: string;
}

export interface DarwinAdHocSmokeExecutableSeal {
  readonly platform: "darwin";
  readonly executablePath: string;
  readonly identifier: typeof DARWIN_PTY_SUPERVISOR_IDENTIFIER;
  readonly teamIdentifier: null;
  readonly cdHash: string;
  readonly sha256: string;
  readonly trustProfile: typeof DARWIN_PTY_PACKAGED_SMOKE_TRUST_PROFILE;
}

export type DarwinPtyExecutableSeal =
  DarwinTrustedExecutableSeal | DarwinAdHocSmokeExecutableSeal;

/**
 * Stage zero is source passed directly in argv to Apple's root/SIP-owned Perl
 * image. It never loads a Nexus file before establishing PT_TRACE_ME.
 *
 * Raw wait4 is intentional: macOS Perl's waitpid wrapper does not expose
 * traced stops reliably. The traced helper is checked at both exec traps:
 * initial launch and the responsibility-disclaiming POSIX_SPAWN_SETEXEC.
 */
export const DARWIN_PTY_STAGE_ZERO_SOURCE = String.raw`
use strict;
use warnings;
no warnings "exec";
use POSIX ();

sub clean {
  my ($value) = @_;
  $value =~ /\A([^\0]*)\z/s or die "stage0: invalid argv\n";
  return $1;
}

my @input = map { clean($_) } @ARGV;
@input >= 11 or die "stage0: incomplete invocation\n";
shift(@input) eq "--helper" or die "stage0: missing helper\n";
my $helper = shift @input;
shift(@input) eq "--identifier" or die "stage0: missing identifier\n";
my $identifier = shift @input;
shift(@input) eq "--team-id" or die "stage0: missing team id\n";
my $team = shift @input;
shift(@input) eq "--cdhash" or die "stage0: missing cdhash\n";
my $cdhash = shift @input;
shift(@input) eq "--timeout-seconds" or die "stage0: missing timeout\n";
my $timeout = shift @input;
shift(@input) eq "--" or die "stage0: missing separator\n";

$helper =~ /\A(\/[^\0\r\n]+)\z/s or die "stage0: invalid helper\n";
$helper = $1;
$identifier =~ /\A([A-Za-z0-9._-]+)\z/ or die "stage0: invalid identifier\n";
$identifier = $1;
$team =~ /\A(-|[A-Z0-9]{10})\z/ or die "stage0: invalid team id\n";
$team = $1;
$cdhash =~ /\A([a-f0-9]{40})\z/ or die "stage0: invalid cdhash\n";
$cdhash = $1;
$timeout =~ /\A([0-9]{1,3})\z/ or die "stage0: invalid timeout\n";
$timeout = 0 + $1;
@input or die "stage0: missing helper arguments\n";

if (exists $ENV{"NEXUS_NODE_PTY_PROVIDER_PATH"}) {
  $ENV{"NEXUS_STAGE0_PROVIDER_PATH"} =
    clean(delete $ENV{"NEXUS_NODE_PTY_PROVIDER_PATH"});
} elsif (exists $ENV{"PATH"}) {
  $ENV{"NEXUS_STAGE0_PROVIDER_PATH"} = clean($ENV{"PATH"});
} else {
  delete $ENV{"NEXUS_STAGE0_PROVIDER_PATH"};
}
$ENV{"PATH"} = "/usr/bin:/bin";
delete @ENV{qw(
  PERL5OPT PERL5LIB PERLLIB PERL5DB PERL_LOCAL_LIB_ROOT
  PERL_MB_OPT PERL_MM_OPT PERL_UNICODE PERLIO PERLIO_DEBUG
  PERL_USE_UNSAFE_INC IFS CDPATH ENV BASH_ENV
)};

my $child = 0;
my $termination = 0;
my $completed = 0;
$SIG{"HUP"} = sub { $termination = 1; };
$SIG{"INT"} = "IGNORE";
$SIG{"QUIT"} = "IGNORE";
$SIG{"TERM"} = sub { $termination = 15; };
$SIG{"ALRM"} = sub { $termination = 14; };

sub raw_wait {
  my ($pid, $flags, $honor_termination) = @_;
  $honor_termination = 1 if !defined($honor_termination);
  while (1) {
    my $packed = pack("i", 0);
    my $waited = syscall(7, $pid, $packed, $flags, 0);
    if ($waited == -1) {
      if ($!{EINTR}) {
        check_termination() if $honor_termination;
        next;
      }
      die "stage0: wait4 failed\n";
    }
    return ($waited, unpack("i", $packed));
  }
}

sub normal_proof_code {
  my ($status) = @_;
  return undef if (($status & 0x7f) != 0);
  my $code = (($status >> 8) & 0xff);
  # A stage-zero observation in 128+signal space is ambiguous: it could be a
  # normal provider status relayed by the helper or the helper itself dying.
  # The signed helper collapses proven provider statuses in this range to 125,
  # so these values can only remain when no proof receipt was emitted.
  return undef if $code >= 129 && $code <= 159;
  return $code;
}

sub terminate_tree {
  my ($exit_code) = @_;
  $termination = 0;
  if ($child > 0) {
    if (syscall(26, 8, $child, 0, 0) == 0) {
      raw_wait($child, 0, 0);
      $child = 0;
      $completed = 1;
      # PT_KILL succeeded while the child was still trace-stopped, before it
      # could create a responsibility cohort. A handled external signal may
      # therefore return the ordinary proven sentinel.
      exit($exit_code >= 129 && $exit_code <= 159 ? 0 : $exit_code);
    }
    kill("TERM", $child);
    # The signed helper has no "give up" timeout: it returns only after two
    # empty responsibility scans. Killing it here would destroy the sole proof
    # authority and could strand a detached provider, so wait without a cap.
    my ($waited, $status) = raw_wait($child, 0, 0);
    $child = 0;
    $completed = 1;
    my $proof_code =
      $waited > 0 ? normal_proof_code($status) : undef;
    # For HUP/TERM, the helper's normal status is the authenticated proof
    # channel. ALRM keeps its public timeout status after the same proof.
    if (defined($proof_code)) {
      exit(
        $exit_code >= 129 && $exit_code <= 159
          ? $proof_code
          : $exit_code
      );
    }
    # A signal-killed helper can leave a detached responsibility cohort.
    # Stay in the reserved unproven band so the host rejects this receipt.
    exit(159);
  }
  $completed = 1;
  exit($exit_code);
}

sub check_termination {
  return if $termination == 0;
  terminate_tree($termination == 14 ? 124 : 128 + $termination);
}

sub continue_trace {
  my ($request) = @_;
  syscall(26, $request, $child, 1, 0) == 0
    or die "stage0: ptrace transition failed\n";
}

sub wait_for_exec_trap {
  while (1) {
    my ($waited, $status) = raw_wait($child, 2);
    check_termination();
    $waited == $child or next;
    my $stopped = (($status & 0xff) == 0x7f);
    if (!$stopped) {
      $child = 0;
      die "stage0: helper exited before authenticated exec\n";
    }
    my $signal = (($status >> 8) & 0xff);
    return if $signal == 5;
    continue_trace(7);
  }
}

sub validate_live_helper {
  my $flags_buffer = pack("L", 0);
  syscall(169, 0 + $child, 0, $flags_buffer, 4) == 0
    or die "stage0: live helper status unavailable\n";
  my $flags = unpack("L", $flags_buffer);
  ($flags & 0x1) == 0x1
    or die "stage0: live helper code signature is invalid\n";

  my $hash_buffer = "\0" x 20;
  syscall(169, 0 + $child, 5, $hash_buffer, 20) == 0
    or die "stage0: live helper CDHash unavailable\n";
  unpack("H*", $hash_buffer) eq $cdhash
    or die "stage0: live helper identity rejected\n";

  my $identity_buffer = "\0" x 256;
  syscall(169, 0 + $child, 11, $identity_buffer, 256) == 0
    or die "stage0: live helper identifier unavailable\n";
  unpack("Z*", substr($identity_buffer, 8)) eq $identifier
    or die "stage0: live helper identifier rejected\n";

  my $team_buffer = "\0" x 256;
  my $team_result = syscall(169, 0 + $child, 14, $team_buffer, 256);
  if ($team eq "-") {
    ($team_result == -1 && (0 + $!) == 2)
      or die "stage0: unexpected live helper Team ID\n";
  } else {
    $team_result == 0
      or die "stage0: live helper Team ID unavailable\n";
    unpack("Z*", substr($team_buffer, 8)) eq $team
      or die "stage0: live helper Team ID rejected\n";
  }
}

END {
  my $saved_status = $?;
  if (!$completed) {
    alarm(0);
    my $cleanup_proven = 1;
    if ($child > 0) {
      if (syscall(26, 8, $child, 0, 0) == 0) {
        my ($waited, $status) = raw_wait($child, 0, 0);
        $cleanup_proven = 0 if $waited != $child;
        $child = 0;
      }
    }
    if ($child > 0) {
      kill("TERM", $child);
      my ($waited, $status) = raw_wait($child, 0, 0);
      $cleanup_proven = 0
        if $waited != $child || !defined(normal_proof_code($status));
      $child = 0;
    }
    if (!$cleanup_proven) {
      $saved_status = 159 << 8;
    }
  }
  $? = $saved_status;
}

my $result = eval {
  $child = fork();
  defined($child) or die "stage0: helper fork failed\n";
  if ($child == 0) {
    syscall(26, 0, 0, 0, 0) == 0 or POSIX::_exit(120);
    exec({$helper} $helper, @input);
    POSIX::_exit(121);
  }
  alarm($timeout) if $timeout > 0;

  wait_for_exec_trap();
  validate_live_helper();
  continue_trace(7);
  wait_for_exec_trap();
  validate_live_helper();
  continue_trace(11);

  my ($waited, $status) = raw_wait($child, 0);
  check_termination();
  alarm(0);
  $waited == $child or die "stage0: helper wait failed\n";
  $child = 0;
  (($status & 0x7f) == 0)
    ? (($status >> 8) & 0xff)
    : (128 + ($status & 0x7f));
};
if (!defined($result)) {
  my $error = $@ || "stage0: unknown failure\n";
  print STDERR $error;
  terminate_tree(76);
}
$completed = 1;
exit($result);
`;

function authenticatedSupervisorArgs(
  seal: DarwinTrustedExecutableSeal,
  args: readonly string[],
): string[] {
  if (
    seal.platform !== "darwin" ||
    !path.isAbsolute(seal.executablePath) ||
    seal.executablePath.includes("\0") ||
    !SIGNING_IDENTIFIER_PATTERN.test(seal.identifier) ||
    !TEAM_IDENTIFIER_PATTERN.test(seal.teamIdentifier) ||
    !CDHASH_PATTERN.test(seal.cdHash) ||
    !SHA256_PATTERN.test(seal.sha256)
  ) {
    throw new Error("Darwin authenticated executable seal is malformed");
  }
  return [
    "supervise-authenticated",
    "--identifier",
    seal.identifier,
    "--team-id",
    seal.teamIdentifier,
    "--cdhash",
    seal.cdHash,
    "--",
    seal.executablePath,
    ...args,
  ];
}

export interface DarwinPtySupervisorExitObservation {
  readonly exitCode: number | null;
  readonly signal?: NodeJS.Signals | number | null;
}

const DARWIN_STAGE_ZERO_SIGNAL_EXIT_MIN = 129;
const DARWIN_STAGE_ZERO_SIGNAL_EXIT_MAX = 159;

/**
 * Stage zero relays a signal-killed helper as 128+signal. The signed helper
 * deliberately collapses proven provider statuses in that range to 125, so an
 * observed 129..159 can only be ambiguous/unproven and must remain fail-closed.
 *
 * A normal exit status of 0 is accepted even when node-pty also surfaces
 * SIGTERM (15): after cooperative stage-zero teardown the status is the
 * proof channel, and a residual signal field must not block app quit.
 * SIGKILL (9) on a zero status remains fail-closed — that is not cooperative.
 */
export function isProvenDarwinPtySupervisorExit(
  observation: DarwinPtySupervisorExitObservation,
): boolean {
  if (!Number.isInteger(observation.exitCode)) return false;
  const code = observation.exitCode!;
  if (code < 0 || code > 255) return false;
  if (
    code >= DARWIN_STAGE_ZERO_SIGNAL_EXIT_MIN &&
    code <= DARWIN_STAGE_ZERO_SIGNAL_EXIT_MAX
  ) {
    return false;
  }
  const signal = observation.signal;
  if (signal === undefined || signal === null || signal === 0) return true;
  if (code === 0 && (signal === 15 || signal === "SIGTERM")) return true;
  return false;
}

export function currentDarwinPtySupervisorRuntime(
  moduleDir: string,
  trustProfile?: typeof DARWIN_PTY_PACKAGED_SMOKE_TRUST_PROFILE,
): DarwinPtySupervisorRuntime {
  const resourcesPath = (
    process as NodeJS.Process & { readonly resourcesPath?: string }
  ).resourcesPath;
  return {
    platform: process.platform,
    packaged: path.resolve(moduleDir).split(path.sep).includes("app.asar"),
    ...(trustProfile ? { trustProfile } : {}),
    ...(resourcesPath ? { resourcesPath } : {}),
    cwd: process.cwd(),
    moduleDir,
  };
}

function developmentHelperCandidates(
  runtime: DarwinPtySupervisorRuntime,
): string[] {
  const candidates = [
    path.join(
      runtime.cwd,
      "resources",
      "native",
      "darwin",
      DARWIN_PTY_SUPERVISOR_NAME,
    ),
    path.resolve(
      runtime.moduleDir,
      "../../../resources/native/darwin",
      DARWIN_PTY_SUPERVISOR_NAME,
    ),
    path.resolve(
      runtime.moduleDir,
      "../../resources/native/darwin",
      DARWIN_PTY_SUPERVISOR_NAME,
    ),
  ];
  return [...new Set(candidates.map((candidate) => path.resolve(candidate)))];
}

function statIdentity(stats: fs.BigIntStats): string {
  return [
    stats.dev,
    stats.ino,
    stats.mode,
    stats.uid,
    stats.gid,
    stats.size,
    stats.mtimeNs,
    stats.ctimeNs,
  ].join(":");
}

function requireRegularExecutable(candidate: string): {
  readonly realPath: string;
  readonly identity: string;
} {
  const stats = fs.lstatSync(candidate, { bigint: true });
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error("helper is not a regular non-symlink file");
  }
  fs.accessSync(candidate, fs.constants.R_OK | fs.constants.X_OK);
  return {
    realPath: fs.realpathSync(candidate),
    identity: statIdentity(stats),
  };
}

function runCodesign(args: readonly string[]): string {
  const result = spawnSync("/usr/bin/codesign", [...args], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
  if (result.error || result.status !== 0 || result.signal !== null) {
    const detail = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
    throw new Error(
      `codesign ${args[0] ?? ""} failed` +
        (detail ? `: ${detail.slice(0, 600)}` : ""),
    );
  }
  return `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
}

export interface DarwinCodeSignatureMetadata {
  readonly identifier: string;
  readonly teamIdentifier: string | null;
  readonly designatedRequirement: string;
  readonly cdHash?: string;
  readonly platformIdentifier?: number;
}

function readCodeSignatureMetadata(
  target: string,
): DarwinCodeSignatureMetadata {
  const output = runCodesign([
    "--display",
    "--verbose=4",
    "--requirements",
    "-",
    target,
  ]);
  const identifier = /^Identifier=(.+)$/mu.exec(output)?.[1]?.trim();
  const rawTeam = /^TeamIdentifier=(.+)$/mu.exec(output)?.[1]?.trim();
  const cdHash = /^CDHash=([a-f0-9]{40})$/imu.exec(output)?.[1]?.toLowerCase();
  const platformIdentifier = /^Platform identifier=(\d+)$/mu.exec(output)?.[1];
  const designatedRequirement = /^#?\s*designated => (.+)$/mu
    .exec(output)?.[1]
    ?.trim();
  if (!identifier || !rawTeam || !cdHash || !designatedRequirement) {
    throw new Error("codesign metadata is incomplete");
  }
  return {
    identifier,
    teamIdentifier: rawTeam === "not set" ? null : rawTeam,
    designatedRequirement,
    cdHash,
    ...(platformIdentifier
      ? { platformIdentifier: Number.parseInt(platformIdentifier, 10) }
      : {}),
  };
}

export function satisfiesPackagedDarwinSupervisorSignaturePolicy(
  helper: DarwinCodeSignatureMetadata,
  app: DarwinCodeSignatureMetadata,
): boolean {
  return (
    helper.identifier === DARWIN_PTY_SUPERVISOR_IDENTIFIER &&
    app.identifier === NEXUS_APP_BUNDLE_IDENTIFIER &&
    helper.teamIdentifier === NEXUS_APPLE_TEAM_ID &&
    app.teamIdentifier === NEXUS_APPLE_TEAM_ID &&
    helper.designatedRequirement.includes(
      `identifier "${DARWIN_PTY_SUPERVISOR_IDENTIFIER}"`,
    ) &&
    app.designatedRequirement.includes(
      `identifier "${NEXUS_APP_BUNDLE_IDENTIFIER}"`,
    ) &&
    helper.designatedRequirement.includes(NEXUS_APPLE_TEAM_ID) &&
    app.designatedRequirement.includes(NEXUS_APPLE_TEAM_ID)
  );
}

function hasExactNexusRequirement(
  metadata: DarwinCodeSignatureMetadata,
  identifier: string,
  teamIdentifier: string | null = NEXUS_APPLE_TEAM_ID,
): boolean {
  if (
    metadata.identifier !== identifier ||
    metadata.teamIdentifier !== teamIdentifier
  ) {
    return false;
  }
  if (teamIdentifier !== null) {
    return (
      metadata.designatedRequirement.includes(`identifier "${identifier}"`) &&
      metadata.designatedRequirement.includes(teamIdentifier)
    );
  }
  /*
   * macOS emits an ad-hoc designated requirement as one (or, for a universal
   * Mach-O, several) CDHash clauses rather than an identifier clause. Bind
   * the exact identifier from the CodeDirectory metadata and independently
   * require its current-architecture CDHash in that designated requirement.
   */
  const cdHash = metadata.cdHash?.toLowerCase();
  return (
    cdHash !== undefined &&
    CDHASH_PATTERN.test(cdHash) &&
    metadata.designatedRequirement.toLowerCase().includes(`cdhash h"${cdHash}"`)
  );
}

export function satisfiesPackagedDarwinAdHocSmokeSignaturePolicy(
  helper: DarwinCodeSignatureMetadata,
  app: DarwinCodeSignatureMetadata,
  utilityHelper: DarwinCodeSignatureMetadata,
): boolean {
  return (
    hasExactNexusRequirement(helper, DARWIN_PTY_SUPERVISOR_IDENTIFIER, null) &&
    hasExactNexusRequirement(app, NEXUS_APP_BUNDLE_IDENTIFIER, null) &&
    hasExactNexusRequirement(
      utilityHelper,
      NEXUS_UTILITY_HELPER_IDENTIFIER,
      null,
    )
  );
}

function hasExactLiveCodeIdentity(
  live: DarwinCodeSignatureMetadata,
  sealed: DarwinCodeSignatureMetadata,
): boolean {
  return (
    Boolean(live.cdHash) &&
    Boolean(sealed.cdHash) &&
    live.identifier === sealed.identifier &&
    live.teamIdentifier === sealed.teamIdentifier &&
    live.cdHash === sealed.cdHash
  );
}

/**
 * The resolver runs in two signed roles: the app's main process and the
 * utilityProcess that owns node-pty. Electron gives the utility executable a
 * distinct code identity, so it must be matched to the exact nested helper
 * sealed by this same app bundle. A same-Team arbitrary binary is insufficient:
 * its ID/CDHash cannot match the nested helper, and the utility's live parent
 * must simultaneously match the bundle's exact main executable.
 */
export function satisfiesPackagedDarwinRuntimeOwnershipPolicy(
  app: DarwinCodeSignatureMetadata,
  utilityHelper: DarwinCodeSignatureMetadata,
  liveProcess: DarwinCodeSignatureMetadata,
  liveParent: DarwinCodeSignatureMetadata | null,
  teamIdentifier: string | null = NEXUS_APPLE_TEAM_ID,
): boolean {
  if (
    !hasExactNexusRequirement(
      app,
      NEXUS_APP_BUNDLE_IDENTIFIER,
      teamIdentifier,
    ) ||
    !hasExactNexusRequirement(
      utilityHelper,
      NEXUS_UTILITY_HELPER_IDENTIFIER,
      teamIdentifier,
    )
  ) {
    return false;
  }
  if (hasExactLiveCodeIdentity(liveProcess, app)) {
    return true;
  }
  return (
    hasExactLiveCodeIdentity(liveProcess, utilityHelper) &&
    liveParent !== null &&
    hasExactLiveCodeIdentity(liveParent, app)
  );
}

function assertSystemPerlLauncher(): void {
  const perl = fs.lstatSync(SYSTEM_PERL_EXECUTABLE, { bigint: true });
  const systemBin = fs.lstatSync("/usr/bin", { bigint: true });
  if (
    !perl.isFile() ||
    perl.isSymbolicLink() ||
    perl.uid !== 0n ||
    (perl.mode & 0o22n) !== 0n ||
    !systemBin.isDirectory() ||
    systemBin.isSymbolicLink() ||
    systemBin.uid !== 0n ||
    (systemBin.mode & 0o22n) !== 0n ||
    fs.realpathSync(SYSTEM_PERL_EXECUTABLE) !== SYSTEM_PERL_EXECUTABLE
  ) {
    throw new Error(
      "Apple stage-zero Perl launcher is not root-owned and sealed",
    );
  }
  runCodesign(["--verify", "--strict", "--verbose=2", SYSTEM_PERL_EXECUTABLE]);
  const metadata = readCodeSignatureMetadata(SYSTEM_PERL_EXECUTABLE);
  if (
    metadata.identifier !== "com.apple.perl" ||
    metadata.teamIdentifier !== null ||
    metadata.platformIdentifier === undefined ||
    metadata.platformIdentifier <= 0 ||
    !metadata.designatedRequirement.includes("anchor apple")
  ) {
    throw new Error("stage-zero launcher is not the Apple platform Perl image");
  }
}

function assertAppOwnedSignature(
  helperPath: string,
  appRoot: string,
  trustProfile?: typeof DARWIN_PTY_PACKAGED_SMOKE_TRUST_PROFILE,
): DarwinPtySupervisorSeal {
  const utilityHelperBundle = path.join(
    appRoot,
    "Contents",
    "Frameworks",
    NEXUS_UTILITY_HELPER_BUNDLE_NAME,
  );
  const utilityHelperPath = path.join(
    utilityHelperBundle,
    "Contents",
    "MacOS",
    NEXUS_UTILITY_HELPER_EXECUTABLE_NAME,
  );
  const mainExecutablePath = path.join(
    appRoot,
    "Contents",
    "MacOS",
    NEXUS_MAIN_EXECUTABLE_NAME,
  );
  const mainFile = requireRegularExecutable(mainExecutablePath);
  const utilityFile = requireRegularExecutable(utilityHelperPath);
  if (
    mainFile.realPath !== mainExecutablePath ||
    utilityFile.realPath !== utilityHelperPath
  ) {
    throw new Error(
      "application executable escaped its exact signed bundle path",
    );
  }
  runCodesign(["--verify", "--strict", "--verbose=2", helperPath]);
  runCodesign([
    "--verify",
    "--deep",
    "--strict",
    "--verbose=2",
    utilityHelperBundle,
  ]);
  runCodesign(["--verify", "--deep", "--strict", "--verbose=2", appRoot]);
  const helper = readCodeSignatureMetadata(helperPath);
  const app = readCodeSignatureMetadata(appRoot);
  const utilityHelper = readCodeSignatureMetadata(utilityFile.realPath);
  const releaseSigned =
    satisfiesPackagedDarwinSupervisorSignaturePolicy(helper, app) &&
    hasExactNexusRequirement(utilityHelper, NEXUS_UTILITY_HELPER_IDENTIFIER);
  const localSmokeAdHoc =
    trustProfile === DARWIN_PTY_PACKAGED_SMOKE_TRUST_PROFILE &&
    satisfiesPackagedDarwinAdHocSmokeSignaturePolicy(
      helper,
      app,
      utilityHelper,
    );
  if (!releaseSigned && !localSmokeAdHoc) {
    throw new Error(
      `helper and application must both carry Nexus Team ID ${NEXUS_APPLE_TEAM_ID}`,
    );
  }
  const expectedTeamIdentifier = releaseSigned ? NEXUS_APPLE_TEAM_ID : null;
  const liveProcess = readCodeSignatureMetadata(String(process.pid));
  const expectedLiveExecutable =
    liveProcess.identifier === NEXUS_APP_BUNDLE_IDENTIFIER
      ? mainExecutablePath
      : liveProcess.identifier === NEXUS_UTILITY_HELPER_IDENTIFIER
        ? utilityHelperPath
        : null;
  if (
    expectedLiveExecutable === null ||
    fs.realpathSync(process.execPath) !== expectedLiveExecutable
  ) {
    throw new Error(
      "running executable is not the exact main/utility image inside this bundle",
    );
  }
  const liveParent =
    liveProcess.identifier === NEXUS_UTILITY_HELPER_IDENTIFIER
      ? readCodeSignatureMetadata(String(process.ppid))
      : null;
  if (
    !satisfiesPackagedDarwinRuntimeOwnershipPolicy(
      app,
      utilityHelper,
      liveProcess,
      liveParent,
      expectedTeamIdentifier,
    )
  ) {
    throw new Error(
      "application bundle does not own the running main/utility code chain",
    );
  }
  if (!helper.cdHash) {
    throw new Error("helper code signature has no CDHash");
  }
  return {
    executablePath: helperPath,
    identifier: helper.identifier,
    teamIdentifier: helper.teamIdentifier,
    cdHash: helper.cdHash,
  };
}

function resolvePackagedDarwinPtySupervisorSeal(
  runtime: DarwinPtySupervisorRuntime,
): DarwinPtySupervisorSeal {
  if (!runtime.resourcesPath || !path.isAbsolute(runtime.resourcesPath)) {
    throw new Error("packaged application has no absolute resourcesPath");
  }
  const resourcesStats = fs.lstatSync(runtime.resourcesPath);
  if (!resourcesStats.isDirectory() || resourcesStats.isSymbolicLink()) {
    throw new Error("packaged Resources is not an application-owned directory");
  }
  const resourcesRoot = fs.realpathSync(runtime.resourcesPath);
  const contentsRoot = path.dirname(resourcesRoot);
  const appRoot = path.dirname(contentsRoot);
  if (
    path.basename(resourcesRoot) !== "Resources" ||
    path.basename(contentsRoot) !== "Contents" ||
    path.extname(appRoot) !== ".app"
  ) {
    throw new Error("resourcesPath is not inside a macOS application bundle");
  }
  const candidate = path.join(resourcesRoot, DARWIN_PTY_SUPERVISOR_NAME);
  const before = requireRegularExecutable(candidate);
  const relative = path.relative(resourcesRoot, before.realPath);
  if (
    relative !== DARWIN_PTY_SUPERVISOR_NAME ||
    path.isAbsolute(relative) ||
    relative.startsWith(`..${path.sep}`)
  ) {
    throw new Error("helper realpath escaped the application Resources root");
  }
  const seal = assertAppOwnedSignature(
    before.realPath,
    appRoot,
    runtime.trustProfile,
  );
  const after = requireRegularExecutable(candidate);
  if (
    after.realPath !== before.realPath ||
    after.identity !== before.identity
  ) {
    throw new Error(
      "helper changed while its application signature was checked",
    );
  }
  return seal;
}

function resolveDevelopmentDarwinPtySupervisorSeal(
  runtime: DarwinPtySupervisorRuntime,
): DarwinPtySupervisorSeal {
  const candidates = developmentHelperCandidates(runtime);
  for (const candidate of candidates) {
    try {
      const before = requireRegularExecutable(candidate);
      runCodesign(["--verify", "--strict", "--verbose=2", before.realPath]);
      const metadata = readCodeSignatureMetadata(before.realPath);
      const after = requireRegularExecutable(candidate);
      if (
        before.realPath !== after.realPath ||
        before.identity !== after.identity ||
        metadata.identifier !== DARWIN_PTY_SUPERVISOR_IDENTIFIER ||
        !metadata.cdHash ||
        (metadata.teamIdentifier !== null &&
          metadata.teamIdentifier !== NEXUS_APPLE_TEAM_ID)
      ) {
        continue;
      }
      return {
        executablePath: after.realPath,
        identifier: metadata.identifier,
        teamIdentifier: metadata.teamIdentifier,
        cdHash: metadata.cdHash,
      };
    } catch {
      continue;
    }
  }
  throw new Error(
    "Darwin PTY responsibility supervisor is missing, non-executable, or " +
      `not a regular application-owned file (checked: ${candidates.join(", ")})`,
  );
}

function resolveDarwinPtySupervisorSeal(
  runtime: DarwinPtySupervisorRuntime,
): DarwinPtySupervisorSeal {
  assertSystemPerlLauncher();
  if (!runtime.packaged) {
    return resolveDevelopmentDarwinPtySupervisorSeal(runtime);
  }
  try {
    return resolvePackagedDarwinPtySupervisorSeal(runtime);
  } catch (error) {
    throw new Error(
      "Packaged Darwin PTY responsibility supervisor failed application-" +
        `ownership verification: ${
          error instanceof Error ? error.message : String(error)
        }`,
    );
  }
}

export function resolveDarwinPtySupervisor(
  runtime: DarwinPtySupervisorRuntime,
): string {
  return resolveDarwinPtySupervisorSeal(runtime).executablePath;
}

/**
 * Resolve the packaged helper as a release-sealed provider for the PTY smoke.
 * Reusing this exact Nexus Team-signed Mach-O means the smoke traverses the
 * same `supervise-authenticated` live-image barrier as a vendor CLI without
 * inventing trust metadata for an Apple system utility.
 */
export function resolvePackagedDarwinPtySmokeProviderSeal(
  runtime: DarwinPtySupervisorRuntime,
): DarwinPtyExecutableSeal {
  if (!runtime.packaged) {
    throw new Error(
      "Darwin authenticated PTY smoke requires the packaged Nexus helper",
    );
  }
  if (runtime.trustProfile !== DARWIN_PTY_PACKAGED_SMOKE_TRUST_PROFILE) {
    throw new Error(
      "Darwin authenticated PTY smoke requires the explicit packaged-smoke trust profile",
    );
  }
  const seal = resolveDarwinPtySupervisorSeal(runtime);

  const before = requireRegularExecutable(seal.executablePath);
  const sha256 = createHash("sha256")
    .update(fs.readFileSync(before.realPath))
    .digest("hex");
  const metadata = readCodeSignatureMetadata(before.realPath);
  const after = requireRegularExecutable(seal.executablePath);
  if (
    before.realPath !== after.realPath ||
    before.identity !== after.identity ||
    metadata.identifier !== seal.identifier ||
    metadata.teamIdentifier !== seal.teamIdentifier ||
    metadata.cdHash !== seal.cdHash
  ) {
    throw new Error(
      "packaged Darwin PTY smoke provider changed while its seal was captured",
    );
  }

  const common = {
    platform: "darwin",
    executablePath: after.realPath,
    identifier: seal.identifier,
    teamIdentifier: seal.teamIdentifier,
    cdHash: seal.cdHash,
    sha256,
  } as const;
  return seal.teamIdentifier === null
    ? Object.freeze({
        ...common,
        identifier: DARWIN_PTY_SUPERVISOR_IDENTIFIER,
        teamIdentifier: null,
        trustProfile: DARWIN_PTY_PACKAGED_SMOKE_TRUST_PROFILE,
      })
    : Object.freeze({
        ...common,
        teamIdentifier: seal.teamIdentifier,
      });
}

function localAdHocSmokeSupervisorArgs(
  runtime: DarwinPtySupervisorRuntime,
  seal: DarwinAdHocSmokeExecutableSeal,
  file: string,
  args: readonly string[],
): string[] {
  if (
    !runtime.packaged ||
    runtime.trustProfile !== DARWIN_PTY_PACKAGED_SMOKE_TRUST_PROFILE ||
    seal.trustProfile !== DARWIN_PTY_PACKAGED_SMOKE_TRUST_PROFILE ||
    file !== seal.executablePath ||
    args.length !== 1 ||
    args[0] !== DARWIN_PTY_PROVIDER_PROBE_MODE ||
    !path.isAbsolute(seal.executablePath) ||
    seal.executablePath.includes("\0") ||
    seal.identifier !== DARWIN_PTY_SUPERVISOR_IDENTIFIER ||
    !CDHASH_PATTERN.test(seal.cdHash) ||
    !SHA256_PATTERN.test(seal.sha256)
  ) {
    throw new Error(
      "Darwin ad-hoc trust is restricted to the packaged local smoke provider probe",
    );
  }
  return [
    "supervise-local-smoke",
    "--cdhash",
    seal.cdHash,
    "--",
    seal.executablePath,
    DARWIN_PTY_PROVIDER_PROBE_MODE,
  ];
}

function packagedReleaseSmokeSupervisorArgs(
  runtime: DarwinPtySupervisorRuntime,
  seal: DarwinTrustedExecutableSeal,
  file: string,
  args: readonly string[],
): string[] {
  if (
    !runtime.packaged ||
    runtime.trustProfile !== DARWIN_PTY_PACKAGED_SMOKE_TRUST_PROFILE ||
    file !== seal.executablePath ||
    args.length !== 1 ||
    args[0] !== DARWIN_PTY_PROVIDER_PROBE_MODE ||
    !path.isAbsolute(seal.executablePath) ||
    seal.executablePath.includes("\0") ||
    seal.identifier !== DARWIN_PTY_SUPERVISOR_IDENTIFIER ||
    seal.teamIdentifier !== NEXUS_APPLE_TEAM_ID ||
    !CDHASH_PATTERN.test(seal.cdHash) ||
    !SHA256_PATTERN.test(seal.sha256)
  ) {
    throw new Error(
      "Darwin release trust is restricted to the packaged smoke provider probe",
    );
  }
  return [
    "supervise-packaged-smoke",
    "--identifier",
    seal.identifier,
    "--team-id",
    seal.teamIdentifier,
    "--cdhash",
    seal.cdHash,
    "--",
    seal.executablePath,
    DARWIN_PTY_PROVIDER_PROBE_MODE,
  ];
}

/**
 * Direct main-process half of the packaged smoke. This does not launch a CLI:
 * it can only trace-exec the exact packaged helper into its zero-effect probe.
 * Real provider launches remain on the authorization-consuming authenticated
 * launcher; the smoke has no mission authority to consume.
 */
export function packagedDarwinPtySmokeSupervisorCommand(
  runtime: DarwinPtySupervisorRuntime,
  seal: DarwinPtyExecutableSeal,
): SupervisedPtyCommand {
  if (
    runtime.platform !== "darwin" ||
    !runtime.packaged ||
    runtime.trustProfile !== DARWIN_PTY_PACKAGED_SMOKE_TRUST_PROFILE ||
    !runtime.resourcesPath ||
    seal.executablePath !==
      path.join(runtime.resourcesPath, DARWIN_PTY_SUPERVISOR_NAME) ||
    seal.identifier !== DARWIN_PTY_SUPERVISOR_IDENTIFIER
  ) {
    throw new Error(
      "packaged-smoke trust is restricted to the packaged Nexus helper probe",
    );
  }
  const helper = resolveDarwinPtySupervisorSeal(runtime);
  if (
    helper.executablePath !== seal.executablePath ||
    helper.identifier !== seal.identifier ||
    helper.teamIdentifier !== seal.teamIdentifier ||
    helper.cdHash !== seal.cdHash
  ) {
    throw new Error(
      "packaged-smoke provider seal does not match the verified bundle helper",
    );
  }
  const helperArgs =
    seal.teamIdentifier === null
      ? localAdHocSmokeSupervisorArgs(runtime, seal, seal.executablePath, [
          DARWIN_PTY_PROVIDER_PROBE_MODE,
        ])
      : packagedReleaseSmokeSupervisorArgs(runtime, seal, seal.executablePath, [
          DARWIN_PTY_PROVIDER_PROBE_MODE,
        ]);
  return stageZeroSupervisorCommand(helper, helperArgs);
}

function stageZeroSupervisorCommand(
  helper: DarwinPtySupervisorSeal,
  helperArgs: readonly string[],
  timeoutSeconds = 0,
): SupervisedPtyCommand {
  if (
    !path.isAbsolute(helper.executablePath) ||
    helper.executablePath.includes("\0") ||
    !SIGNING_IDENTIFIER_PATTERN.test(helper.identifier) ||
    (helper.teamIdentifier !== null &&
      !TEAM_IDENTIFIER_PATTERN.test(helper.teamIdentifier)) ||
    !CDHASH_PATTERN.test(helper.cdHash) ||
    !Number.isInteger(timeoutSeconds) ||
    timeoutSeconds < 0 ||
    timeoutSeconds > 999 ||
    helperArgs.length === 0
  ) {
    throw new Error("Darwin helper live-image seal is malformed");
  }
  return {
    file: SYSTEM_PERL_EXECUTABLE,
    args: [
      "-T",
      "-e",
      DARWIN_PTY_STAGE_ZERO_SOURCE,
      "--",
      "--helper",
      helper.executablePath,
      "--identifier",
      helper.identifier,
      "--team-id",
      helper.teamIdentifier ?? "-",
      "--cdhash",
      helper.cdHash,
      "--timeout-seconds",
      String(timeoutSeconds),
      "--",
      ...helperArgs,
    ],
  };
}

export interface AuthenticatedDarwinSupervisorCommandOptions {
  readonly qualificationProbe?: boolean;
}

/**
 * Build the only command permitted to execute a release-sealed provider on
 * Darwin. Apple's root/SIP-owned Perl image trace-execs and authenticates both
 * helper images. The helper then trace-execs the provider and validates its
 * live SecCode before detaching it.
 *
 * This is also used for qualification probes: probing `--version` must not
 * execute a pathname directly before the live-image barrier has taken effect.
 */
export function authenticatedDarwinSupervisorCommand(
  runtime: DarwinPtySupervisorRuntime,
  seal: DarwinTrustedExecutableSeal,
  args: readonly string[],
  options: AuthenticatedDarwinSupervisorCommandOptions = {},
): SupervisedPtyCommand {
  if (runtime.platform !== "darwin") {
    throw new Error(
      "authenticated executable seal has no immutable launcher on this platform",
    );
  }
  if (runtime.trustProfile === DARWIN_PTY_PACKAGED_SMOKE_TRUST_PROFILE) {
    throw new Error(
      "packaged-smoke trust cannot enter the general authenticated CLI launcher",
    );
  }
  const helperArgs = authenticatedSupervisorArgs(seal, args);
  return stageZeroSupervisorCommand(
    resolveDarwinPtySupervisorSeal(runtime),
    helperArgs,
    options.qualificationProbe ? VERSION_PROBE_TIMEOUT_SECONDS : 0,
  );
}

/**
 * On macOS every node-pty command is rooted in a signed, self-responsible
 * native supervisor. Other platforms retain node-pty's direct spawn.
 */
export function supervisedPtyCommand(
  runtime: DarwinPtySupervisorRuntime,
  file: string,
  args: readonly string[],
  seal?: DarwinPtyExecutableSeal,
): SupervisedPtyCommand {
  if (runtime.platform !== "darwin") {
    if (seal) {
      throw new Error(
        "authenticated executable seal has no immutable launcher on this platform",
      );
    }
    return { file, args: [...args] };
  }
  if (!path.isAbsolute(file) || file.includes("\0")) {
    throw new Error(
      "Darwin PTY supervisor requires an absolute, NUL-free command path",
    );
  }
  if (runtime.trustProfile === DARWIN_PTY_PACKAGED_SMOKE_TRUST_PROFILE) {
    if (
      !seal ||
      file !== seal.executablePath ||
      args.length !== 1 ||
      args[0] !== DARWIN_PTY_PROVIDER_PROBE_MODE
    ) {
      throw new Error(
        "packaged-smoke trust is restricted to the packaged Nexus helper probe",
      );
    }
    return packagedDarwinPtySmokeSupervisorCommand(runtime, seal);
  }
  if (seal?.teamIdentifier === null) {
    const helperArgs = localAdHocSmokeSupervisorArgs(runtime, seal, file, args);
    return stageZeroSupervisorCommand(
      resolveDarwinPtySupervisorSeal(runtime),
      helperArgs,
    );
  }
  if (seal) {
    if (file === SYSTEM_SEATBELT_EXECUTABLE) {
      if (
        args.length < 3 ||
        args[0] !== "-p" ||
        !args[1] ||
        args[1].includes("\0") ||
        args[2] !== seal.executablePath
      ) {
        throw new Error(
          "Darwin authenticated Seatbelt plan does not target the sealed executable",
        );
      }
      const helperCommand = stageZeroSupervisorCommand(
        resolveDarwinPtySupervisorSeal(runtime),
        authenticatedSupervisorArgs(seal, args.slice(3)),
      );
      return {
        file,
        // Seatbelt execs Apple's stage zero. Stage zero authenticates the
        // helper, which then authenticates the exact provider live image.
        args: ["-p", args[1], helperCommand.file, ...helperCommand.args],
      };
    }
    if (file !== seal.executablePath) {
      throw new Error(
        "Darwin authenticated launch does not target the sealed executable",
      );
    }
    return authenticatedDarwinSupervisorCommand(runtime, seal, args);
  }
  return stageZeroSupervisorCommand(resolveDarwinPtySupervisorSeal(runtime), [
    "supervise",
    "--",
    file,
    ...args,
  ]);
}
