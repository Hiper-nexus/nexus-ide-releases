/**
 * Runs in a fresh Node worker for every LSP request.
 *
 * Keep this as source text instead of a bundled Worker entry: Electron Forge
 * ships only the main Vite bundle, and an eval worker lets main retain exact
 * lifecycle authority (including hard termination on timeout). The worker
 * loads the packaged TypeScript runtime by an absolute path supplied by main.
 */
export const LSP_WORKER_SOURCE = String.raw`
'use strict';

const workerThreads = module.require('node:worker_threads');
const fs = module.require('node:fs');
const path = module.require('node:path');
const ts = module.require(workerThreads.workerData.typescriptPath);
const parentPort = workerThreads.parentPort;
const input = workerThreads.workerData;
const limits = input.limits;
const startedAt = Date.now();
const deadline = startedAt + limits.workerBudgetMs;
let filesRead = 0;
let bytesRead = 0;
let directoriesRead = 0;
const contentCache = new Map();

function fail(message) {
  throw new Error(String(message).slice(0, 512));
}

function checkDeadline() {
  if (Date.now() > deadline) fail('LSP worker exceeded its internal time limit');
}

function inside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

const root = fs.realpathSync(path.resolve(input.rootRealPath));
if (root !== path.resolve(input.rootRealPath)) {
  fail('execution scope identity changed on disk');
}
const typescriptLibRoot = fs.realpathSync(path.dirname(input.typescriptPath));

function classifyPath(candidate) {
  const absolute = path.resolve(candidate);
  if (inside(root, absolute)) {
    const relative = path.relative(root, absolute).split(path.sep)
      .map((segment) => segment.toLowerCase());
    if (relative.includes('.git') || relative.includes('.nexus')) return null;
    return { kind: 'workspace', absolute };
  }
  if (inside(typescriptLibRoot, absolute)) return { kind: 'typescript-lib', absolute };
  return null;
}

function safeRealFile(candidate) {
  const classified = classifyPath(candidate);
  if (!classified) return null;
  let stat;
  let real;
  try {
    const lstat = fs.lstatSync(classified.absolute);
    if (lstat.isSymbolicLink() || !lstat.isFile()) return null;
    real = fs.realpathSync(classified.absolute);
    stat = fs.statSync(real);
  } catch {
    return null;
  }
  const allowedRoot = classified.kind === 'workspace' ? root : typescriptLibRoot;
  if (!inside(allowedRoot, real) || real !== classified.absolute) return null;
  if (!stat.isFile() || stat.nlink !== 1 || stat.size > limits.maxFileBytes) {
    return null;
  }
  return { absolute: real, stat, kind: classified.kind };
}

function safeRead(candidate) {
  checkDeadline();
  const existing = contentCache.get(path.resolve(candidate));
  if (existing !== undefined) return existing;
  const file = safeRealFile(candidate);
  if (!file) return undefined;
  if (filesRead >= limits.maxReadFiles) fail('LSP file-read limit exceeded');
  if (bytesRead + file.stat.size > limits.maxTotalBytes) {
    fail('LSP total-byte limit exceeded');
  }
  filesRead += 1;
  bytesRead += file.stat.size;
  let fd;
  let content;
  try {
    fd = fs.openSync(
      file.absolute,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0)
    );
    const descriptor = fs.fstatSync(fd);
    const pathStat = fs.lstatSync(file.absolute);
    const realAfterOpen = fs.realpathSync(file.absolute);
    const allowedRoot = file.kind === 'workspace' ? root : typescriptLibRoot;
    if (
      !descriptor.isFile() ||
      descriptor.nlink !== 1 ||
      descriptor.dev !== file.stat.dev ||
      descriptor.ino !== file.stat.ino ||
      pathStat.isSymbolicLink() ||
      pathStat.dev !== descriptor.dev ||
      pathStat.ino !== descriptor.ino ||
      realAfterOpen !== file.absolute ||
      !inside(allowedRoot, realAfterOpen)
    ) {
      fail('LSP source changed while it was being opened');
    }
    content = fs.readFileSync(fd, 'utf8');
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  contentCache.set(file.absolute, content);
  return content;
}

function safeFileExists(candidate) {
  checkDeadline();
  return safeRealFile(candidate) !== null;
}

function safeDirectory(candidate) {
  checkDeadline();
  const classified = classifyPath(candidate);
  if (!classified) return null;
  try {
    const lstat = fs.lstatSync(classified.absolute);
    if (lstat.isSymbolicLink() || !lstat.isDirectory()) return null;
    const real = fs.realpathSync(classified.absolute);
    const allowedRoot = classified.kind === 'workspace' ? root : typescriptLibRoot;
    if (real !== classified.absolute || !inside(allowedRoot, real)) return null;
    return real;
  } catch {
    return null;
  }
}

function safeDirectoryExists(candidate) {
  return safeDirectory(candidate) !== null;
}

function safeGetDirectories(candidate) {
  const directory = safeDirectory(candidate);
  if (!directory) return [];
  if (directoriesRead >= limits.maxDirectories) {
    fail('LSP directory-read limit exceeded');
  }
  directoriesRead += 1;
  return fs.readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
    .slice(0, limits.maxDirectoryEntries)
    .map((entry) => path.join(directory, entry.name));
}

const SOURCE_RE = /\.(?:[cm]?[jt]sx?)$/i;
const TYPESCRIPT_SOURCE_EXTENSIONS = [
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
];
const JAVASCRIPT_SOURCE_EXTENSIONS = [
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
];
const SOURCE_EXTENSIONS = [
  ...TYPESCRIPT_SOURCE_EXTENSIONS,
  ...JAVASCRIPT_SOURCE_EXTENSIONS,
];
const IGNORED_DIRS = new Set([
  '.git',
  '.nexus',
  '.hg',
  '.svn',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'out',
]);

function scanWorkspaceScripts() {
  const scripts = [];
  const queue = [root];
  while (queue.length > 0) {
    checkDeadline();
    if (directoriesRead >= limits.maxDirectories) {
      fail('LSP directory-read limit exceeded');
    }
    const directory = queue.shift();
    directoriesRead += 1;
    const entries = fs.readdirSync(directory, { withFileTypes: true });
    if (entries.length > limits.maxDirectoryEntries) {
      fail('LSP directory entry limit exceeded');
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      checkDeadline();
      if (entry.isSymbolicLink()) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name)) queue.push(absolute);
        continue;
      }
      if (!entry.isFile() || !SOURCE_RE.test(entry.name)) continue;
      const file = safeRealFile(absolute);
      if (!file || file.kind !== 'workspace') continue;
      if (scripts.length >= limits.maxProjectFiles) {
        fail('LSP project-file limit exceeded');
      }
      scripts.push(file.absolute);
    }
  }
  return scripts;
}

function matchFileSystemEntries(candidate) {
  checkDeadline();
  const directory = safeDirectory(candidate);
  if (!directory) return { files: [], directories: [] };
  if (directoriesRead >= limits.maxDirectories) {
    fail('LSP directory-read limit exceeded');
  }
  directoriesRead += 1;
  const entries = fs.readdirSync(directory, { withFileTypes: true });
  if (entries.length > limits.maxDirectoryEntries) {
    fail('LSP directory entry limit exceeded');
  }
  const files = [];
  const directories = [];
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      if (!IGNORED_DIRS.has(entry.name)) directories.push(entry.name);
    } else if (entry.isFile()) {
      files.push(entry.name);
    }
  }
  return { files, directories };
}

function hasSupportedSourceExtension(candidate, extensions) {
  const lower = candidate.toLowerCase();
  return extensions.some((extension) => lower.endsWith(extension));
}

function scriptsFromConfig(config, options) {
  const scripts = new Set();
  const rawConfiguredFiles = Array.isArray(config.files) ? config.files : null;
  if (rawConfiguredFiles && rawConfiguredFiles.length > limits.maxProjectFiles) {
    fail('LSP project-file limit exceeded');
  }
  const configuredFiles = rawConfiguredFiles || [];
  const sourceExtensions = options.allowJs === true
    ? SOURCE_EXTENSIONS
    : TYPESCRIPT_SOURCE_EXTENSIONS;
  for (const configured of configuredFiles) {
    if (typeof configured !== 'string') continue;
    const file = safeRealFile(path.resolve(root, configured));
    if (
      file &&
      file.kind === 'workspace' &&
      hasSupportedSourceExtension(file.absolute, sourceExtensions)
    ) {
      scripts.add(file.absolute);
    }
  }
  const includes = Array.isArray(config.include)
    ? config.include.filter((value) => typeof value === 'string').slice(0, 128)
    : rawConfiguredFiles
      ? []
      : ['**/*'];
  if (includes.length > 0) {
    const configuredExcludes = Array.isArray(config.exclude)
      ? config.exclude.filter((value) => typeof value === 'string').slice(0, 128)
      : [];
    const excludes = [
      ...configuredExcludes,
      '**/.git/**',
      '**/.nexus/**',
      '**/node_modules/**',
      '**/build/**',
      '**/coverage/**',
      '**/dist/**',
      '**/out/**',
    ];
    const matched = ts.matchFiles(
      root,
      sourceExtensions,
      excludes,
      includes,
      ts.sys.useCaseSensitiveFileNames,
      root,
      undefined,
      matchFileSystemEntries,
      (candidate) => candidate
    );
    for (const candidate of matched) {
      const file = safeRealFile(candidate);
      if (
        file &&
        file.kind === 'workspace' &&
        hasSupportedSourceExtension(file.absolute, sourceExtensions)
      ) {
        scripts.add(file.absolute);
      }
      if (scripts.size > limits.maxProjectFiles) {
        fail('LSP project-file limit exceeded');
      }
    }
  }
  return [...scripts].sort();
}

function safeProjectConfig() {
  const defaults = {
    allowJs: false,
    checkJs: false,
    jsx: ts.JsxEmit.Preserve,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    noEmit: true,
    skipLibCheck: true,
    target: ts.ScriptTarget.ES2022,
    types: [],
  };
  const dedicatedConfigPath = path.join(root, 'tsconfig.lsp.json');
  const defaultConfigPath = path.join(root, 'tsconfig.json');
  const dedicatedConfigText = safeRead(dedicatedConfigPath);
  const configPath =
    dedicatedConfigText === undefined ? defaultConfigPath : dedicatedConfigPath;
  const configText =
    dedicatedConfigText === undefined
      ? safeRead(defaultConfigPath)
      : dedicatedConfigText;
  if (configText === undefined || Buffer.byteLength(configText, 'utf8') > limits.maxConfigBytes) {
    return {
      options: { ...defaults, allowJs: true },
      scripts: scanWorkspaceScripts(),
    };
  }
  const parsedText = ts.parseConfigFileTextToJson(configPath, configText);
  if (parsedText.error || !parsedText.config || typeof parsedText.config !== 'object') {
    return {
      options: { ...defaults, allowJs: true },
      scripts: scanWorkspaceScripts(),
    };
  }
  const compilerJson =
    parsedText.config.compilerOptions && typeof parsedText.config.compilerOptions === 'object'
      ? parsedText.config.compilerOptions
      : {};
  const converted = ts.convertCompilerOptionsFromJson(compilerJson, root);
  const options = { ...defaults, ...converted.options, noEmit: true, plugins: undefined };
  for (const key of ['baseUrl', 'outDir', 'rootDir']) {
    if (typeof options[key] === 'string' && !inside(root, options[key])) {
      delete options[key];
    }
  }
  for (const key of ['rootDirs', 'typeRoots']) {
    if (Array.isArray(options[key])) {
      options[key] = options[key].filter((candidate) =>
        typeof candidate === 'string' && inside(root, candidate)
      ).slice(0, 32);
    }
  }
  if (Array.isArray(options.types)) options.types = options.types.slice(0, 32);
  return {
    options,
    scripts: scriptsFromConfig(parsedText.config, options),
  };
}

function relativeResultPath(fileName) {
  let real;
  try {
    real = fs.realpathSync(path.resolve(fileName));
  } catch {
    return null;
  }
  if (!inside(root, real)) return null;
  const relative = path.relative(root, real).split(path.sep).join('/');
  return relative || null;
}

function clip(value, max) {
  return String(value || '').slice(0, max);
}

function sourcePositionFromSource(source, fileName, span) {
  const relative = relativeResultPath(fileName);
  if (!relative) return null;
  const start = source.getLineAndCharacterOfPosition(
    Math.max(0, Math.min(source.getFullWidth(), span.start))
  );
  const endOffset = Math.max(span.start, span.start + span.length);
  const end = source.getLineAndCharacterOfPosition(
    Math.max(0, Math.min(source.getFullWidth(), endOffset))
  );
  return {
    path: relative,
    line: start.line + 1,
    column: start.character + 1,
    endLine: end.line + 1,
    endColumn: end.character + 1,
  };
}

function sourcePosition(service, fileName, span) {
  const source = service.getProgram()?.getSourceFile(fileName);
  if (!source) return null;
  return sourcePositionFromSource(source, fileName, span);
}

function targetOffset(service, targetPath, line, column) {
  const source = service.getProgram()?.getSourceFile(targetPath);
  if (!source) fail('target source file is unavailable to TypeScript');
  const lines = source.getLineStarts();
  if (!Number.isInteger(line) || line < 1 || line > lines.length) {
    fail('line is outside target source');
  }
  const lineStart = lines[line - 1];
  const lineEnd = line < lines.length ? lines[line] : source.getFullWidth();
  const maxColumn = Math.max(1, lineEnd - lineStart + 1);
  if (!Number.isInteger(column) || column < 1 || column > maxColumn) {
    fail('column is outside target source');
  }
  return lineStart + column - 1;
}

function flattenNavigationTree(source, targetPath, tree, maxResults) {
  const items = [];
  const visit = (node, container) => {
    if (items.length >= maxResults) return;
    if (node.text && node.text !== '<global>') {
      const position = sourcePositionFromSource(
        source,
        targetPath,
        node.spans[0] || { start: 0, length: 0 }
      );
      if (position) {
        items.push({
          ...position,
          name: clip(node.text, 256),
          kind: clip(node.kind, 64),
          modifiers: clip(node.kindModifiers, 128),
          container: container ? clip(container, 256) : undefined,
        });
      }
    }
    const nextContainer = node.text && node.text !== '<global>' ? node.text : container;
    for (const child of node.childItems || []) visit(child, nextContainer);
  };
  visit(tree, undefined);
  return items;
}

function diagnosticSeverity(category) {
  if (category === ts.DiagnosticCategory.Error) return 'error';
  if (category === ts.DiagnosticCategory.Warning) return 'warning';
  if (category === ts.DiagnosticCategory.Suggestion) return 'suggestion';
  return 'message';
}

function execute() {
  const targetPath = fs.realpathSync(path.resolve(root, input.query.path));
  if (!inside(root, targetPath) || !SOURCE_RE.test(targetPath)) {
    fail('LSP target must be a JavaScript or TypeScript source inside execution scope');
  }
  const target = safeRealFile(targetPath);
  if (!target || target.kind !== 'workspace') fail('LSP target is not a safe regular file');

  const project = safeProjectConfig();
  const scripts = project.scripts;
  if (!scripts.includes(target.absolute)) scripts.push(target.absolute);
  if (scripts.length > limits.maxProjectFiles) fail('LSP project-file limit exceeded');
  const options = project.options;
  const snapshots = new Map();
  const moduleHost = {
    fileExists: safeFileExists,
    readFile: safeRead,
    directoryExists: safeDirectoryExists,
    getDirectories: safeGetDirectories,
    realpath: (candidate) => safeRealFile(candidate)?.absolute || candidate,
    getCurrentDirectory: () => root,
  };
  const host = {
    getScriptFileNames: () => scripts,
    getScriptVersion: () => '1',
    getScriptSnapshot: (fileName) => {
      const absolute = path.resolve(fileName);
      const cached = snapshots.get(absolute);
      if (cached) return cached;
      const content = safeRead(absolute);
      if (content === undefined) return undefined;
      const snapshot = ts.ScriptSnapshot.fromString(content);
      snapshots.set(absolute, snapshot);
      return snapshot;
    },
    getCompilationSettings: () => options,
    getDefaultLibFileName: (compilerOptions) => ts.getDefaultLibFilePath(compilerOptions),
    getCurrentDirectory: () => root,
    getNewLine: () => '\n',
    useCaseSensitiveFileNames: () => ts.sys.useCaseSensitiveFileNames,
    fileExists: safeFileExists,
    readFile: safeRead,
    directoryExists: safeDirectoryExists,
    getDirectories: safeGetDirectories,
    realpath: (candidate) => safeRealFile(candidate)?.absolute || candidate,
    resolveModuleNames: (moduleNames, containingFile) =>
      moduleNames.map((moduleName) =>
        ts.resolveModuleName(moduleName, containingFile, options, moduleHost).resolvedModule
      ),
  };
  const service = ts.createLanguageService(host, ts.createDocumentRegistry());
  const maxResults = Math.max(1, Math.min(limits.maxResults, input.query.maxResults || limits.defaultResults));
  let items = [];

  checkDeadline();
  if (input.query.kind === 'symbols') {
    const targetSource = ts.createSourceFile(
      target.absolute,
      safeRead(target.absolute) || '',
      options.target || ts.ScriptTarget.ES2022,
      true
    );
    const tree = service.getNavigationTree(target.absolute);
    items = flattenNavigationTree(targetSource, target.absolute, tree, maxResults);
  } else if (input.query.kind === 'definition' || input.query.kind === 'references') {
    const offset = targetOffset(
      service,
      target.absolute,
      input.query.line,
      input.query.column
    );
    const raw = input.query.kind === 'definition'
      ? service.getDefinitionAtPosition(target.absolute, offset) || []
      : service.getReferencesAtPosition(target.absolute, offset) || [];
    for (const entry of raw) {
      if (items.length >= maxResults) break;
      const position = sourcePosition(service, entry.fileName, entry.textSpan);
      if (!position) continue;
      items.push({
        ...position,
        name: clip(entry.name, 256),
        kind: clip(entry.kind, 64),
        isDefinition: entry.isDefinition === true || undefined,
        isWriteAccess: entry.isWriteAccess === true || undefined,
      });
    }
  } else if (input.query.kind === 'diagnostics') {
    const raw = [
      ...service.getSyntacticDiagnostics(target.absolute),
      ...service.getSemanticDiagnostics(target.absolute),
    ];
    for (const diagnostic of raw) {
      if (items.length >= maxResults) break;
      const span = {
        start: typeof diagnostic.start === 'number' ? diagnostic.start : 0,
        length: typeof diagnostic.length === 'number' ? diagnostic.length : 0,
      };
      const position = sourcePosition(service, target.absolute, span);
      if (!position) continue;
      items.push({
        ...position,
        code: diagnostic.code,
        severity: diagnosticSeverity(diagnostic.category),
        message: clip(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'), 1024),
      });
    }
  } else {
    fail('unsupported LSP query');
  }
  checkDeadline();

  const result = {
    language: 'typescript',
    path: path.relative(root, target.absolute).split(path.sep).join('/'),
    truncated: items.length >= maxResults,
    items,
    budget: {
      filesRead,
      bytesRead,
      directoriesRead,
      elapsedMs: Date.now() - startedAt,
    },
  };
  while (
    result.items.length > 0 &&
    Buffer.byteLength(JSON.stringify(result), 'utf8') > limits.maxOutputBytes
  ) {
    result.items.pop();
    result.truncated = true;
  }
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > limits.maxOutputBytes) {
    fail('LSP output-byte limit exceeded');
  }
  return result;
}

try {
  parentPort.postMessage({ ok: true, result: execute() });
} catch (error) {
  parentPort.postMessage({
    ok: false,
    error: error && error.message ? String(error.message).slice(0, 512) : 'LSP worker failed',
  });
}
`;
