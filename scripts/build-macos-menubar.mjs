#!/usr/bin/env node
/**
 * Compila o app companheiro de menu bar (Nexus Redline) em
 * `resources/native/darwin/nexus-redline/Nexus Redline.app`:
 *
 *   native/menubar-redline/main.swift
 *     └─ swiftc -O → Contents/MacOS/NexusRedline
 *     └─ Info.plist (LSUIElement, com.nexuside.redline)
 *     └─ Resources/AppIcon.icns (reusa assets/icon.icns)
 *     └─ codesign ad-hoc
 *
 * No-op em plataformas não-darwin (o companion é macOS-only).
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDir, "..");
const sourceDir = path.join(root, "native", "menubar-redline");
const source = path.join(sourceDir, "main.swift");
// Todo .swift do companheiro entra no binário, exceto os de teste; ordenado
// para o argv do swiftc ser determinístico.
const sources = readdirSync(sourceDir)
  .filter((name) => name.endsWith(".swift") && !name.endsWith(".test.swift"))
  .sort()
  .map((name) => path.join(sourceDir, name));
const icon = path.join(root, "assets", "icon.icns");
const defaultOutput = path.join(
  root,
  "resources",
  "native",
  "darwin",
  "nexus-redline",
  "Nexus Redline.app",
);

const SOURCE_IDENTITY = "Nexus Redline — app companheiro de menu bar do NexusIDE";

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
  throw new Error("usage: build-macos-menubar.mjs [--output <path>]");
}

function run(tool, args, options = {}) {
  return execFileSync(tool, args, {
    cwd: root,
    encoding: "utf8",
    stdio: options.capture ? "pipe" : "inherit",
  });
}

function assertSourceIdentity() {
  const observed = readFileSync(source, "utf8");
  if (!observed.includes(SOURCE_IDENTITY)) {
    throw new Error("Nexus Redline source identity is invalid");
  }
}

function infoPlist(version) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Nexus Redline</string>
  <key>CFBundleDisplayName</key><string>Nexus Redline</string>
  <key>CFBundleIdentifier</key><string>com.nexuside.redline</string>
  <key>CFBundleVersion</key><string>${version}</string>
  <key>CFBundleShortVersionString</key><string>${version}</string>
  <key>CFBundleExecutable</key><string>NexusRedline</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>LSUIElement</key><true/>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
`;
}

/**
 * Compila e monta o .app. Retorna o caminho final do bundle.
 */
export function buildMenubarCompanion({ output = defaultOutput } = {}) {
  if (process.platform !== "darwin") {
    console.log("[redline] skip: companion é macOS-only");
    return null;
  }
  assertSourceIdentity();

  const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  const version = String(pkg.version ?? "0.0.0");

  const staging = mkdtempSync(path.join(os.tmpdir(), "redline-build-"));
  const binary = path.join(staging, "NexusRedline");
  try {
    run("swiftc", [
      "-O",
      "-swift-version",
      "5",
      "-o",
      binary,
      ...sources,
    ], { capture: true });

    const contents = path.join(output, "Contents");
    const macosDir = path.join(contents, "MacOS");
    const resourcesDir = path.join(contents, "Resources");
    rmSync(output, { recursive: true, force: true });
    mkdirSync(macosDir, { recursive: true });
    mkdirSync(resourcesDir, { recursive: true });

    writeFileSync(path.join(contents, "Info.plist"), infoPlist(version));
    const builtBinary = path.join(macosDir, "NexusRedline");
    copyFileSync(binary, builtBinary);
    run("chmod", ["755", builtBinary], { capture: true });
    if (existsSync(icon)) {
      copyFileSync(icon, path.join(resourcesDir, "AppIcon.icns"));
    }

    // Assinatura ad-hoc: o bundle precisa estar assinado para o Gatekeeper
    // aceitar spawn via NSWorkspace/SMAppService. Release re-assina por cima
    // com Developer ID no postPackage do Forge (mesmo fluxo do pty supervisor).
    run("codesign", [
      "--force",
      "--deep",
      "--sign",
      "-",
      "--timestamp=none",
      output,
    ], { capture: true });
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }

  console.log(`[redline] companion built: ${output}`);
  return output;
}

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const { output } = parseBuildArguments(process.argv.slice(2));
  buildMenubarCompanion({ output });
}
