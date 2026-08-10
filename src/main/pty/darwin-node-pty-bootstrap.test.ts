import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import * as nodePty from "@lydell/node-pty";

import {
  DARWIN_NODE_PTY_BOOTSTRAP_SOURCE,
  DARWIN_NODE_PTY_PROVIDER_PATH_ENV,
  darwinNodePtyBootstrapLaunch,
} from "./darwin-node-pty-bootstrap";

const temporaryDirectories: string[] = [];
const activeTerminals = new Set<nodePty.IPty>();
const temporaryNodePtyHelpers = new Set<string>();

afterEach(() => {
  for (const terminal of activeTerminals) {
    try {
      terminal.kill("SIGKILL");
    } catch {
      // A normally reaped PTY is the expected path.
    }
  }
  activeTerminals.clear();
  for (const helper of temporaryNodePtyHelpers) {
    try {
      fs.unlinkSync(helper);
    } catch {
      // A test may have completed its own exact cleanup.
    }
  }
  temporaryNodePtyHelpers.clear();
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

/**
 * Polls the receipt the exec'd image writes. Under Vitest the node-pty data
 * callback never fires (its exit callback does), so a stdout assertion would
 * measure the runner instead of the bootstrap. This is a real-PTY integration
 * test, so fake timers cannot model it: the wait is bounded and proves the
 * receipt ARRIVES, not that it arrives instantly.
 */
async function waitForOutput(
  receiptPath: string,
  marker: string,
  timeoutMs = 10_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let seen = "";
    try {
      seen = fs.readFileSync(receiptPath, "utf8");
    } catch {
      // The exec'd image may not have written the receipt yet.
    }
    if (seen.includes(marker)) return seen;
    if (Date.now() >= deadline) return seen;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function waitForExit(
  terminal: nodePty.IPty,
  timeoutMs = 8_000,
): Promise<{ exitCode: number; signal?: number }> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Darwin bootstrap PTY did not exit")),
      timeoutMs,
    );
    terminal.onExit((event) => {
      clearTimeout(timeout);
      activeTerminals.delete(terminal);
      resolve(event);
    });
  });
}

describe("Darwin node-pty system bootstrap plan", () => {
  it("constructs the exact -T/-e argv and sanitizes Perl startup controls", () => {
    const launch = darwinNodePtyBootstrapLaunch(
      "/tmp/workspace",
      "/usr/bin/true",
      ["argument"],
      {
        PATH: "relative:/provider/bin",
        PERL5OPT: "-Mmalicious",
        PERL5LIB: "/tmp/mutable",
        KEEP_ME: "yes",
      },
    );

    expect(launch).toMatchObject({
      file: "-e",
      cwd: "-T",
      args: [
        DARWIN_NODE_PTY_BOOTSTRAP_SOURCE,
        "--",
        "/tmp/workspace",
        "/usr/bin/true",
        "argument",
      ],
    });
    expect(launch.env).toMatchObject({
      PATH: "/usr/bin:/bin",
      [DARWIN_NODE_PTY_PROVIDER_PATH_ENV]: "relative:/provider/bin",
      KEEP_ME: "yes",
    });
    expect(launch.env).not.toHaveProperty("PERL5OPT");
    expect(launch.env).not.toHaveProperty("PERL5LIB");
  });

  it("rejects relative or NUL-bearing launch authority", () => {
    expect(() =>
      darwinNodePtyBootstrapLaunch(
        "relative",
        "/usr/bin/true",
        [],
        {},
      ),
    ).toThrow(/absolute/);
    expect(() =>
      darwinNodePtyBootstrapLaunch(
        "/tmp",
        "/usr/bin/true",
        ["bad\0arg"],
        {},
      ),
    ).toThrow(/NUL-free/);
  });
});

describe.runIf(process.platform === "darwin")(
  "Darwin node-pty system bootstrap integration",
  () => {
    it("opens a real PTY and untaints cwd, command, and argv before exec", async () => {
      const root = fs.mkdtempSync(
        path.join(os.tmpdir(), "nexus bootstrap cwd with spaces "),
      );
      temporaryDirectories.push(root);
      // The receipt is written to a file, not only to the PTY: under Vitest the
      // node-pty data callback does not deliver (the exit event does), so an
      // stdout-only assertion would test the runner, not the bootstrap. The
      // file carries the exact same proof — untainted cwd, argv and provider
      // PATH, observed from inside the exec'd image on a real TTY.
      const receipt = path.join(root, "bootstrap-receipt.txt");
      const stageOne = String.raw`
use strict;
use warnings;
my $provider_path = delete $ENV{"NEXUS_NODE_PTY_PROVIDER_PATH"};
defined($provider_path) or die "missing provider path\n";
$provider_path =~ /\A([^\0]*)\z/s or die "invalid provider path\n";
$ENV{"PATH"} = $1;
my $line = sprintf "BOOTSTRAP_CWD=%s ARG=%s PATH=%s TTY=%s\n",
  $ENV{"PWD"}, $ARGV[0], $ENV{"PATH"}, (-t 0 ? "yes" : "no");
print $line;
my $receipt = $ARGV[1];
$receipt =~ /\A(\/[^\0]*)\z/s or die "invalid receipt path\n";
open(my $fh, ">", $1) or die "cannot open receipt\n";
print $fh $line;
close($fh) or die "cannot close receipt\n";
`;
      const launch = darwinNodePtyBootstrapLaunch(
        root,
        "/usr/bin/perl",
        ["-e", stageOne, "--", "tainted argument", receipt],
        {
          ...Object.fromEntries(
            Object.entries(process.env).filter(
              (entry): entry is [string, string] =>
                typeof entry[1] === "string",
            ),
          ),
          PATH: "relative:/provider/bin:/usr/bin:/bin",
          PERL5OPT: "-Mmodule_that_must_not_load",
          PERL5LIB: "/tmp/mutable-perl-library",
          TERM: "xterm-256color",
        },
      );
      const output: string[] = [];
      const terminal = nodePty.spawn(launch.file, [...launch.args], {
        name: "xterm-256color",
        cols: 80,
        rows: 24,
        cwd: launch.cwd,
        env: launch.env,
      });
      activeTerminals.add(terminal);
      terminal.onData((chunk) => output.push(chunk));

      await expect(waitForExit(terminal)).resolves.toMatchObject({
        exitCode: 0,
      });
      const printed = await waitForOutput(receipt, `BOOTSTRAP_CWD=${root}`);
      expect(printed).toContain(`BOOTSTRAP_CWD=${root}`);
      expect(printed).toContain("ARG=tainted argument");
      expect(printed).toContain("PATH=relative:/provider/bin:/usr/bin:/bin");
      expect(printed).toContain("TTY=yes");
    });

    it("never executes a swapped legacy spawn-helper constructor", async () => {
      const root = fs.mkdtempSync(
        path.join(os.tmpdir(), "nexus-node-pty-legacy-helper-"),
      );
      temporaryDirectories.push(root);
      const marker = path.join(root, "constructor.marker");
      const source = path.join(root, "malicious-spawn-helper.c");
      const compiled = path.join(root, "malicious-spawn-helper");
      const platformPackage = path.join(
        process.cwd(),
        "node_modules",
        "@lydell",
        `node-pty-darwin-${process.arch}`,
      );
      const legacyHelper = path.join(
        platformPackage,
        "prebuilds",
        `darwin-${process.arch}`,
        "spawn-helper",
      );
      expect(fs.existsSync(legacyHelper)).toBe(false);
      fs.writeFileSync(
        source,
        [
          "#include <fcntl.h>",
          "#include <unistd.h>",
          "__attribute__((constructor)) static void mark(void) {",
          `  int fd = open(${JSON.stringify(marker)}, O_WRONLY | O_CREAT | O_TRUNC, 0600);`,
          '  if (fd >= 0) { (void)write(fd, "executed", 8); (void)close(fd); }',
          "}",
          "int main(void) { return 97; }",
          "",
        ].join("\n"),
      );
      execFileSync("xcrun", ["clang", source, "-o", compiled]);
      fs.mkdirSync(path.dirname(legacyHelper), { recursive: true });
      fs.copyFileSync(compiled, legacyHelper);
      fs.chmodSync(legacyHelper, 0o755);
      temporaryNodePtyHelpers.add(legacyHelper);

      const launch = darwinNodePtyBootstrapLaunch(
        root,
        "/usr/bin/perl",
        ["-e", 'print "SYSTEM_PERL_HELPER_OK\\n"'],
        {
          PATH: "/usr/bin:/bin",
          TERM: "xterm-256color",
        },
      );
      const output: string[] = [];
      const terminal = nodePty.spawn(launch.file, [...launch.args], {
        name: "xterm-256color",
        cols: 80,
        rows: 24,
        cwd: launch.cwd,
        env: launch.env,
      });
      activeTerminals.add(terminal);
      terminal.onData((chunk) => output.push(chunk));

      await expect(waitForExit(terminal)).resolves.toMatchObject({
        exitCode: 0,
      });
      expect(output.join("")).toContain("SYSTEM_PERL_HELPER_OK");
      expect(fs.existsSync(marker)).toBe(false);
      fs.unlinkSync(legacyHelper);
      temporaryNodePtyHelpers.delete(legacyHelper);
    });
  },
);
