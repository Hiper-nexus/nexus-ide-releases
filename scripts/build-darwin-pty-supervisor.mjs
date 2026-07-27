import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDir, "..");
const source = path.join(root, "native", "darwin-pty-supervisor", "main.c");
const defaultOutput = path.join(
  root,
  "resources",
  "native",
  "darwin",
  "nexus-pty-supervisor",
);

export function parseBuildArguments(argv) {
  if (argv.length === 0) return { output: defaultOutput };
  if (
    argv.length === 2 &&
    argv[0] === "--output" &&
    typeof argv[1] === "string" &&
    argv[1].trim() !== ""
  ) {
    return { output: path.resolve(argv[1]) };
  }
  throw new Error("usage: build-darwin-pty-supervisor.mjs [--output <path>]");
}

function run(tool, args, options = {}) {
  return execFileSync(tool, args, {
    cwd: root,
    encoding: "utf8",
    stdio: options.capture ? "pipe" : "inherit",
  });
}

function assertSourceIdentity() {
  const observed = realpathSync(source);
  if (
    observed !== source ||
    !readFileSync(source, "utf8").includes(
      "NexusIDE Darwin PTY responsibility supervisor",
    )
  ) {
    throw new Error("Darwin PTY supervisor source identity is invalid");
  }
}

export function buildDarwinPtySupervisor({
  output = defaultOutput,
  platform = process.platform,
} = {}) {
  if (platform !== "darwin") {
    process.stdout.write(
      "[darwin-pty-supervisor] non-Darwin host: native helper build skipped\n",
    );
    return { skipped: true, output: null };
  }
  assertSourceIdentity();
  const outputDir = path.dirname(output);
  mkdirSync(outputDir, { recursive: true, mode: 0o755 });
  const scratch = mkdtempSync(
    path.join(outputDir, ".nexus-pty-supervisor-build-"),
  );
  const arm64 = path.join(scratch, "nexus-pty-supervisor-arm64");
  const x64 = path.join(scratch, "nexus-pty-supervisor-x86_64");
  const universal = path.join(scratch, "nexus-pty-supervisor-universal");
  const common = [
    "-std=c11",
    "-O2",
    "-Wall",
    "-Wextra",
    "-Werror",
    "-Wpedantic",
    "-mmacosx-version-min=11.0",
    source,
    "-lproc",
    "-framework",
    "CoreFoundation",
    "-framework",
    "Security",
  ];
  try {
    run("xcrun", [
      "--sdk",
      "macosx",
      "clang",
      "-arch",
      "arm64",
      ...common,
      "-o",
      arm64,
    ]);
    run("xcrun", [
      "--sdk",
      "macosx",
      "clang",
      "-arch",
      "x86_64",
      ...common,
      "-o",
      x64,
    ]);
    run("xcrun", ["lipo", "-create", arm64, x64, "-output", universal]);
    chmodSync(universal, 0o755);
    /*
     * responsibility_spawnattrs_setdisclaim only establishes self
     * responsibility for signed code.  Ad-hoc signing is mandatory for local
     * development; Forge replaces it with the app's Developer ID during a
     * distributable release.
     */
    run("codesign", [
      "--force",
      "--sign",
      "-",
      "--identifier",
      "nexus-pty-supervisor",
      "--timestamp=none",
      universal,
    ]);
    run("codesign", ["--verify", "--strict", universal]);
    const architectures = run("xcrun", ["lipo", "-archs", universal], {
      capture: true,
    })
      .trim()
      .split(/\s+/u)
      .sort();
    if (
      architectures.length !== 2 ||
      architectures[0] !== "arm64" ||
      architectures[1] !== "x86_64"
    ) {
      throw new Error(
        `Darwin PTY supervisor is not universal: ${architectures.join(" ")}`,
      );
    }
    const staged = path.join(outputDir, `.nexus-pty-supervisor-${process.pid}`);
    if (existsSync(staged)) rmSync(staged, { force: true });
    renameSync(universal, staged);
    chmodSync(staged, 0o755);
    renameSync(staged, output);
    run("codesign", ["--verify", "--strict", output]);
    process.stdout.write(
      `[darwin-pty-supervisor] universal ad-hoc-signed helper: ${output}\n`,
    );
    return { skipped: false, output };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const options = parseBuildArguments(process.argv.slice(2));
  buildDarwinPtySupervisor(options);
}
