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

/**
 * Piso declarado no Info.plist e no Mach-O. Sem `-target`, o swiftc carimba
 * `minos` com a versão do SDK (chegou a 27.2 num Mac 27.0). O Launch Services
 * recusa o app com «Você não pode usar esta versão…» e oferece Atualização
 * de Software — o plist 14.0 não vence o minos do binário.
 */
export const REDLINE_MINIMUM_SYSTEM_VERSION = "14.0";
export const REDLINE_SWIFT_TARGET = `arm64-apple-macosx${REDLINE_MINIMUM_SYSTEM_VERSION}`;

export function redlineSwiftcArgs(binary, sources) {
  return [
    "-O",
    "-swift-version",
    "5",
    "-target",
    REDLINE_SWIFT_TARGET,
    "-o",
    binary,
    ...sources,
  ];
}

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

/** Falha o build se o linker carimbar um minos diferente do piso do plist. */
export function assertRedlineDeploymentTarget(binary, showBuild = null) {
  const observed = showBuild ?? run("vtool", ["-show-build", binary], { capture: true });
  const minos = String(observed).match(/^\s*minos\s+(\S+)\s*$/m)?.[1];
  if (minos !== REDLINE_MINIMUM_SYSTEM_VERSION) {
    throw new Error(
      `Nexus Redline minos ${minos ?? "ausente"} != ${REDLINE_MINIMUM_SYSTEM_VERSION} (LC_BUILD_VERSION)`,
    );
  }
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
  <key>LSMinimumSystemVersion</key><string>${REDLINE_MINIMUM_SYSTEM_VERSION}</string>
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
    run("swiftc", redlineSwiftcArgs(binary, sources), { capture: true });
    assertRedlineDeploymentTarget(binary);

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

    // Logos de provedor rasterizados + manifest, e o NOTICE de
    // marca/proveniência — as marcas não viajam para outro bundle sem ele.
    const logoSrc = path.join(root, "native", "menubar-redline", "assets", "provider-logos");
    const logoDest = path.join(resourcesDir, "provider-logos");
    if (existsSync(logoSrc)) {
      mkdirSync(logoDest, { recursive: true });
      for (const name of readdirSync(logoSrc).sort()) {
        copyFileSync(path.join(logoSrc, name), path.join(logoDest, name));
      }
    }
    const notice = path.join(root, "src", "renderer", "assets", "provider-logos", "NOTICE.md");
    if (existsSync(notice)) {
      copyFileSync(notice, path.join(logoDest, "NOTICE.md"));
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
