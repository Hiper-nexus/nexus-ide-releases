#!/usr/bin/env node
/**
 * Compila o companheiro de bandeja do Windows (Nexus Redline) em
 * `resources/native/win32/nexus-redline/NexusRedline.exe`:
 *
 *   native/windows-tray-redline/redline-model.cc (parser + formato, sem Win32)
 *   native/windows-tray-redline/redline-tray.cc  (bandeja/painel/autostart)
 *     └─ cl /W4 /WX → NexusRedline.exe (SUBSYSTEM:WINDOWS, sem console)
 *     └─ redline-version.rc (VERSIONINFO carimbado com package.json + ícone)
 *     └─ provider-logos/ + NOTICE.md (as marcas não viajam sem ele)
 *
 * No-op em plataformas não-win32 (o MSVC só existe no Windows).
 * O bundle é comitado ("carimbado" por versão, igual ao .app do Mac) e o
 * Forge o embarca no instalador; a assinatura Authenticode acontece no
 * worker de release junto com os demais executáveis.
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
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDir, "..");
const sourceDir = path.join(root, "native", "windows-tray-redline");
const modelSource = path.join(sourceDir, "redline-model.cc");
const traySource = path.join(sourceDir, "redline-tray.cc");
const manifestSource = path.join(sourceDir, "redline.manifest");
const iconSource = path.join(root, "assets", "icon.ico");
const logoSrc = path.join(
  root,
  "native",
  "menubar-redline",
  "assets",
  "provider-logos",
);
const noticeSrc = path.join(
  root,
  "src",
  "renderer",
  "assets",
  "provider-logos",
  "NOTICE.md",
);
const defaultOutputDir = path.join(
  root,
  "resources",
  "native",
  "win32",
  "nexus-redline",
);
const defaultOutput = path.join(defaultOutputDir, "NexusRedline.exe");

const SOURCE_IDENTITY = "Nexus Redline (Windows)";

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
  throw new Error("usage: build-windows-tray.mjs [--output <path>]");
}

function assertSourceIdentity() {
  for (const file of [modelSource, traySource]) {
    const observed = readFileSync(file, "utf8");
    if (!observed.includes(SOURCE_IDENTITY)) {
      throw new Error(`Nexus Redline source identity is invalid: ${file}`);
    }
  }
}

function locateVisualStudio() {
  const programFilesX86 =
    process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
  const vswhere = path.join(
    programFilesX86,
    "Microsoft Visual Studio",
    "Installer",
    "vswhere.exe",
  );
  if (!existsSync(vswhere)) {
    throw new Error(
      "MSVC x64 não encontrado: instale o Visual Studio Build Tools com a carga C++",
    );
  }
  const found = execFileSync(
    vswhere,
    [
      "-latest",
      "-products",
      "*",
      "-requires",
      "Microsoft.VisualStudio.Component.VC.Tools.x86.x64",
      "-property",
      "installationPath",
    ],
    { encoding: "utf8" },
  ).trim();
  if (!found) {
    throw new Error(
      "MSVC x64 não encontrado: instale o Visual Studio Build Tools com a carga C++",
    );
  }
  return found;
}

function versionQuad(version) {
  const parts = String(version ?? "0.0.0")
    .split(".")
    .map((n) => Number.parseInt(n, 10));
  while (parts.length < 4) parts.push(0);
  if (parts.some((n) => !Number.isInteger(n) || n < 0 || n > 65535)) {
    throw new Error(`Versão inválida para VERSIONINFO: ${version}`);
  }
  return parts.slice(0, 4);
}

function versionRc(version, iconPath, manifestPath) {
  const [major, minor, patch, build] = versionQuad(version);
  const versionString = `${major}.${minor}.${patch}`;
  const esc = (s) => s.replace(/\\/g, "\\\\").replace(/"/g, '""');
  return `#include <windows.h>
IDI_ICON1 ICON "${esc(iconPath)}"
1 RT_MANIFEST "${esc(manifestPath)}"
VS_VERSION_INFO VERSIONINFO
FILEVERSION ${major},${minor},${patch},${build}
PRODUCTVERSION ${major},${minor},${patch},${build}
FILEFLAGSMASK VS_FFI_FILEFLAGSMASK
FILEFLAGS 0
FILEOS VOS_NT_WINDOWS32
FILETYPE VFT_APP
FILESUBTYPE VFT2_UNKNOWN
BEGIN
  BLOCK "StringFileInfo"
  BEGIN
    BLOCK "040904B0"
    BEGIN
      VALUE "CompanyName", "NexusIDE"
      VALUE "FileDescription", "Nexus Redline \\u2014 cotas das contas de IA na bandeja"
      VALUE "FileVersion", "${versionString}"
      VALUE "InternalName", "NexusRedline"
      VALUE "OriginalFilename", "NexusRedline.exe"
      VALUE "ProductName", "Nexus Redline"
      VALUE "ProductVersion", "${versionString}"
    END
  END
  BLOCK "VarFileInfo"
  BEGIN
    VALUE "Translation", 0x409, 1200
  END
END
`;
}

/**
 * Compila e monta o bundle. Retorna o caminho final do executável.
 */
export function buildWindowsTray({ output = defaultOutput } = {}) {
  if (process.platform !== "win32") {
    console.log("[redline] skip: companion de bandeja só compila no Windows");
    return { skipped: true, output: null };
  }
  assertSourceIdentity();
  if (!existsSync(iconSource)) {
    throw new Error(`Ícone do Windows ausente: ${iconSource}`);
  }

  const pkg = JSON.parse(
    readFileSync(path.join(root, "package.json"), "utf8"),
  );
  const version = String(pkg.version ?? "0.0.0");

  const vsInstallation = locateVisualStudio();
  const staging = mkdtempSync(path.join(os.tmpdir(), "redline-tray-build-"));
  const exePath = path.join(staging, "NexusRedline.exe");
  // /Fo com vários .cc exige diretório (D8036), não um .obj único.
  // Barra normal no fim: `\"` seria lido pelo cl como aspa escapada (D8003).
  const objDir = `${staging}/`;
  const resPath = path.join(staging, "redline-version.res");
  try {
    // O .rc referencia ícone e manifesto por caminho absoluto: o build pode
    // rodar em qualquer cwd sem quebrar o resource compiler.
    const rcPath = path.join(staging, "redline-version.rc");
    writeFileSync(rcPath, versionRc(version, iconSource, manifestSource));

    // Compila via VsDevCmd (mesma técnica do spike windows-pty-job/run.ps1):
    // um .cmd efêmero carrega o ambiente MSVC, imprime o toolchain e compila
    // com warnings como erro — igual ao rigor do build do Mac (-Werror).
    const compileCmd = path.join(staging, "compile.cmd");
    const lines = [
      "@echo off",
      `call "${vsInstallation}\\Common7\\Tools\\VsDevCmd.bat" -arch=x64 -host_arch=x64 >nul`,
      "if errorlevel 1 exit /b 1",
      "echo MSVC_TOOLSET=%VCToolsVersion%",
      "echo WINDOWS_SDK=%WindowsSDKVersion%",
      `rc /nologo /fo "${resPath}" "${rcPath}"`,
      "if errorlevel 1 exit /b 1",
      `cl /nologo /EHsc /std:c++17 /W4 /WX /permissive- /utf-8 /DUNICODE /D_UNICODE /D_WIN32_WINNT=0x0A00 /Fe:"${exePath}" /Fo:"${objDir}" "${modelSource}" "${traySource}" "${resPath}" /link /INCREMENTAL:NO /DYNAMICBASE /NXCOMPAT /SUBSYSTEM:WINDOWS /ENTRY:wWinMainCRTStartup gdiplus.lib shell32.lib advapi32.lib dwmapi.lib user32.lib gdi32.lib`,
      "exit /b %errorlevel%",
    ];
    writeFileSync(compileCmd, lines.join("\r\n"), "ascii");
    const compiled = spawnSync("cmd.exe", ["/d", "/c", compileCmd], {
      cwd: root,
      encoding: "utf8",
      stdio: "inherit",
      timeout: 10 * 60_000,
    });
    if (compiled.error) throw compiled.error;
    if (compiled.status !== 0 || !existsSync(exePath)) {
      throw new Error("MSVC falhou ao compilar o Nexus Redline");
    }

    // Monta o bundle comitado: exe + logos + NOTICE (espelha o .app do Mac).
    const outDir = path.dirname(output);
    rmSync(output, { force: true });
    rmSync(path.join(outDir, "provider-logos"), {
      recursive: true,
      force: true,
    });
    mkdirSync(outDir, { recursive: true });
    copyFileSync(exePath, output);
    const logoDest = path.join(outDir, "provider-logos");
    mkdirSync(logoDest, { recursive: true });
    for (const name of readdirSync(logoSrc).sort()) {
      copyFileSync(path.join(logoSrc, name), path.join(logoDest, name));
    }
    if (existsSync(noticeSrc)) {
      copyFileSync(noticeSrc, path.join(logoDest, "NOTICE.md"));
    }
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }

  console.log(`[redline] tray companion built: ${output}`);
  return { skipped: false, output };
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const { output } = parseBuildArguments(process.argv.slice(2));
  buildWindowsTray({ output });
}
