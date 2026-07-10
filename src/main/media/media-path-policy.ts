import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

export interface MediaInputFile {
  path: string;
  data: Buffer;
}

const OUTPUT_FILE_MODE = 0o644;
const TEMP_SUFFIX_BYTES = 12;

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative === '' ||
    (relative !== '..' &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

function canonicalWorkspace(baseDir: string): {
  lexical: string;
  canonical: string;
} {
  const lexical = path.resolve(baseDir);
  let canonical: string;
  try {
    canonical = fs.realpathSync(lexical);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`workspace de mídia indisponível: ${detail}`);
  }
  if (!fs.statSync(canonical).isDirectory()) {
    throw new Error('workspace de mídia não é um diretório');
  }
  return { lexical, canonical };
}

function lexicalWorkspacePath(inputPath: string, baseDir: string): {
  candidate: string;
  canonicalRoot: string;
} {
  const root = canonicalWorkspace(baseDir);
  const candidate = path.isAbsolute(inputPath)
    ? path.resolve(inputPath)
    : path.resolve(root.lexical, inputPath);
  if (!isInside(root.lexical, candidate)) {
    throw new Error(`caminho de mídia escapa o workspace: ${inputPath}`);
  }
  return { candidate, canonicalRoot: root.canonical };
}

function nearestExistingAncestor(targetPath: string): string {
  let current = targetPath;
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return current;
}

function assertCanonicalContainment(
  canonicalRoot: string,
  targetPath: string,
  originalPath: string,
): void {
  const canonicalTarget = fs.realpathSync(targetPath);
  if (!isInside(canonicalRoot, canonicalTarget)) {
    throw new Error(`caminho de mídia escapa o workspace: ${originalPath}`);
  }
}

/** Resolve an output without allowing absolute, `..`, or symlink escapes. */
export function resolveMediaOutputPath(inputPath: string, baseDir: string): string {
  const { candidate, canonicalRoot } = lexicalWorkspacePath(inputPath, baseDir);
  const existingAncestor = nearestExistingAncestor(candidate);
  assertCanonicalContainment(canonicalRoot, existingAncestor, inputPath);

  if (fs.existsSync(candidate)) {
    const metadata = fs.lstatSync(candidate);
    if (metadata.isSymbolicLink()) {
      throw new Error(`output de mídia não pode ser symlink: ${inputPath}`);
    }
    if (!metadata.isFile()) {
      throw new Error(`output de mídia não é arquivo regular: ${inputPath}`);
    }
    if (metadata.nlink > 1) {
      throw new Error(`output de mídia não pode ser hardlink: ${inputPath}`);
    }
    assertCanonicalContainment(canonicalRoot, candidate, inputPath);
  }
  return candidate;
}

/** Read an input once through an O_NOFOLLOW descriptor after realpath checks. */
export function readMediaInput(inputPath: string, baseDir: string): MediaInputFile {
  const { candidate, canonicalRoot } = lexicalWorkspacePath(inputPath, baseDir);
  let canonicalInput: string;
  try {
    canonicalInput = fs.realpathSync(candidate);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`input de mídia indisponível: ${inputPath} (${detail})`);
  }
  if (!isInside(canonicalRoot, canonicalInput)) {
    throw new Error(`caminho de mídia escapa o workspace: ${inputPath}`);
  }

  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0);
  const fd = fs.openSync(canonicalInput, flags);
  try {
    if (!fs.fstatSync(fd).isFile()) {
      throw new Error(`input de mídia não é arquivo regular: ${inputPath}`);
    }
    return { path: canonicalInput, data: fs.readFileSync(fd) };
  } finally {
    fs.closeSync(fd);
  }
}

/** Recheck containment at write time and never follow a final-component link. */
export function writeMediaOutput(
  outputPath: string,
  baseDir: string,
  data: Buffer,
): void {
  const resolved = resolveMediaOutputPath(outputPath, baseDir);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });

  const { canonical: canonicalRoot } = canonicalWorkspace(baseDir);
  assertCanonicalContainment(canonicalRoot, path.dirname(resolved), outputPath);
  if (fs.existsSync(resolved) && fs.lstatSync(resolved).isSymbolicLink()) {
    throw new Error(`output de mídia não pode ser symlink: ${outputPath}`);
  }

  const tempPath = path.join(
    path.dirname(resolved),
    `.${path.basename(resolved)}.nexus-${randomBytes(TEMP_SUFFIX_BYTES).toString('hex')}.tmp`,
  );
  const flags =
    fs.constants.O_WRONLY |
    fs.constants.O_CREAT |
    fs.constants.O_EXCL |
    (fs.constants.O_NOFOLLOW ?? 0);
  let fd: number | null = fs.openSync(tempPath, flags, OUTPUT_FILE_MODE);
  try {
    const metadata = fs.fstatSync(fd);
    if (!metadata.isFile()) {
      throw new Error(`output de mídia não é arquivo regular: ${outputPath}`);
    }
    if (metadata.nlink > 1) {
      throw new Error(`output de mídia não pode ser hardlink: ${outputPath}`);
    }
    fs.writeFileSync(fd, data);
    fs.closeSync(fd);
    fd = null;

    // A long provider request gives local filesystem state time to change.
    // Revalidate immediately before the atomic replace.
    resolveMediaOutputPath(outputPath, baseDir);
    fs.renameSync(tempPath, resolved);
  } finally {
    if (fd !== null) fs.closeSync(fd);
    fs.rmSync(tempPath, { force: true });
  }
}
