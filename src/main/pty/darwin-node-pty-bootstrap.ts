import path from "node:path";

export const DARWIN_NODE_PTY_SYSTEM_HELPER = "/usr/bin/perl";
export const DARWIN_NODE_PTY_PROVIDER_PATH_ENV =
  "NEXUS_NODE_PTY_PROVIDER_PATH";

const PERL_STARTUP_ENVIRONMENT_KEYS = Object.freeze([
  "PERL5OPT",
  "PERL5LIB",
  "PERLLIB",
  "PERL5DB",
  "PERL_LOCAL_LIB_ROOT",
  "PERL_MB_OPT",
  "PERL_MM_OPT",
  "PERL_UNICODE",
  "PERLIO",
  "PERLIO_DEBUG",
  "PERL_USE_UNSAFE_INC",
  "IFS",
  "CDPATH",
  "ENV",
  "BASH_ENV",
]);

/**
 * node-pty's macOS native binding executes:
 *
 *   helperPath, cwd, file, ...args
 *
 * The pinned dependency patch makes helperPath Apple's root/SIP-owned Perl.
 * `cwd=-T` and `file=-e` therefore establish taint mode before this source is
 * parsed. No executable controlled by the app runs until this bootstrap has
 * opened the PTY, changed directory, and exec'd the absolute main-owned plan.
 */
export const DARWIN_NODE_PTY_BOOTSTRAP_SOURCE = String.raw`
use strict;
use warnings;
no warnings "exec";
use POSIX ();
use Fcntl ();

sub clean {
  my ($value) = @_;
  $value =~ /\A([^\0]*)\z/s or die "node-pty bootstrap: invalid argv\n";
  return $1;
}

my @input = map { clean($_) } @ARGV;
@input >= 2 or die "node-pty bootstrap: incomplete invocation\n";
my $cwd = shift @input;
my $command = shift @input;
$cwd =~ /\A(\/[^\0]*)\z/s
  or die "node-pty bootstrap: cwd must be absolute\n";
$cwd = $1;
$command =~ /\A(\/[^\0]*)\z/s
  or die "node-pty bootstrap: command must be absolute\n";
$command = $1;

delete @ENV{qw(
  PERL5OPT PERL5LIB PERLLIB PERL5DB PERL_LOCAL_LIB_ROOT
  PERL_MB_OPT PERL_MM_OPT PERL_UNICODE PERLIO PERLIO_DEBUG
  PERL_USE_UNSAFE_INC IFS CDPATH ENV BASH_ENV
)};
$ENV{"PATH"} = "/usr/bin:/bin";
$ENV{"PWD"} = $cwd;

my $tty = POSIX::ttyname(0);
defined($tty) or die "node-pty bootstrap: stdin has no tty\n";
$tty =~ /\A(\/dev\/[^\0\r\n]+)\z/s
  or die "node-pty bootstrap: invalid tty path\n";
$tty = $1;
sysopen(my $tty_handle, $tty, Fcntl::O_RDWR())
  or die "node-pty bootstrap: cannot open tty\n";
close($tty_handle) or die "node-pty bootstrap: cannot close tty\n";
chdir($cwd) or die "node-pty bootstrap: cannot chdir\n";
exec { $command } $command, @input;
die "node-pty bootstrap: exec failed\n";
`;

export interface DarwinNodePtyBootstrapLaunch {
  readonly file: "-e";
  readonly args: readonly string[];
  readonly cwd: "-T";
  readonly env: Record<string, string>;
}

function requireNulFree(value: string, label: string): string {
  if (value.includes("\0")) {
    throw new Error(`Darwin node-pty bootstrap ${label} must be NUL-free`);
  }
  return value;
}

export function darwinNodePtyBootstrapLaunch(
  actualCwd: string,
  actualFile: string,
  actualArgs: readonly string[],
  providerEnvironment: Readonly<Record<string, string>>,
): DarwinNodePtyBootstrapLaunch {
  if (!path.isAbsolute(actualCwd) || !path.isAbsolute(actualFile)) {
    throw new Error(
      "Darwin node-pty bootstrap requires absolute cwd and command paths",
    );
  }
  requireNulFree(actualCwd, "cwd");
  requireNulFree(actualFile, "command");
  const args = actualArgs.map((value) => requireNulFree(value, "argv"));

  const env = { ...providerEnvironment };
  const providerPath = env.PATH;
  for (const key of PERL_STARTUP_ENVIRONMENT_KEYS) delete env[key];
  env.PATH = "/usr/bin:/bin";
  if (providerPath === undefined) {
    delete env[DARWIN_NODE_PTY_PROVIDER_PATH_ENV];
  } else {
    env[DARWIN_NODE_PTY_PROVIDER_PATH_ENV] = requireNulFree(
      providerPath,
      "provider PATH",
    );
  }

  return {
    file: "-e",
    args: [
      DARWIN_NODE_PTY_BOOTSTRAP_SOURCE,
      "--",
      actualCwd,
      actualFile,
      ...args,
    ],
    cwd: "-T",
    env,
  };
}
