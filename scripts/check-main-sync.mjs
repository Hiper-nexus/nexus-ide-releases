// F-764: static ratchet for synchronous process execution in Electron Main.
// This is a source-maintenance check, not a sandbox for hostile JavaScript.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

const SINKS = new Set(['spawnSync', 'execSync', 'execFileSync']);
const PROCESS_MODULES = new Set(['child_process', 'node:child_process']);
const EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.cjs', '.mjs']);

function normalizedTokens(source) {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, source);
  const tokens = [];
  while (scanner.scan() !== ts.SyntaxKind.EndOfFileToken) tokens.push(scanner.getTokenText());
  return JSON.stringify(tokens);
}

/** Parse/bind one file, keeping local shadowing distinct from imported aliases. */
export function findSyncProcessUses(source, file = 'src/main/example.ts') {
  if (!/child_process|spawnSync|execSync|execFileSync/.test(source)) return [];
  // TypeScript normalizes host paths even when Node uses Windows separators.
  const filename = path.resolve(file).replaceAll('\\', '/');
  const sf = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true);
  if (sf.parseDiagnostics.length) throw new Error(`cannot audit invalid source: ${file}`);
  const host = {
    getSourceFile: (name) => name === filename ? sf : undefined,
    getDefaultLibFileName: () => '', writeFile() {}, getCurrentDirectory: () => process.cwd(),
    getDirectories: () => [], fileExists: (name) => name === filename,
    readFile: (name) => name === filename ? source : undefined,
    getCanonicalFileName: (name) => name, useCaseSensitiveFileNames: () => true,
    getNewLine: () => '\n',
  };
  const program = ts.createProgram([filename], { noResolve: true, noLib: true, allowJs: true }, host);
  const checker = program.getTypeChecker();
  const bindings = new Map();
  const uses = [];
  const visit = (node, fn) => { fn(node); ts.forEachChild(node, (child) => visit(child, fn)); };
  const symbol = (node) => checker.getSymbolAtLocation(node);
  function unwrap(node) {
    while (node && (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) ||
      ts.isTypeAssertionExpression(node) || ts.isNonNullExpression(node) || ts.isAwaitExpression(node))) {
      node = node.expression;
    }
    return node;
  }
  function stringValue(node, depth = 0) {
    node = unwrap(node);
    if (!node || depth > 12) return null;
    if (ts.isStringLiteralLike(node)) return node.text;
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const left = stringValue(node.left, depth + 1), right = stringValue(node.right, depth + 1);
      return left === null || right === null ? null : left + right;
    }
    if (ts.isIdentifier(node)) {
      const declaration = symbol(node)?.valueDeclaration;
      if (declaration && ts.isVariableDeclaration(declaration)) return stringValue(declaration.initializer, depth + 1);
    }
    return null;
  }
  function kind(node) {
    node = unwrap(node);
    if (!node) return null;
    if (ts.isIdentifier(node)) return bindings.get(symbol(node)) ?? null;
    if (ts.isCallExpression(node) &&
        ((ts.isIdentifier(node.expression) && node.expression.text === 'require') ||
          node.expression.kind === ts.SyntaxKind.ImportKeyword) &&
        PROCESS_MODULES.has(stringValue(node.arguments[0]))) return 'namespace';
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const key = ts.isPropertyAccessExpression(node) ? node.name.text : stringValue(node.argumentExpression);
      if (kind(node.expression) === 'namespace' && SINKS.has(key)) return key;
      if (['call', 'apply'].includes(key) && SINKS.has(kind(node.expression))) return kind(node.expression);
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === 'bind' && SINKS.has(kind(node.expression.expression))) {
      return kind(node.expression.expression);
    }
    return null;
  }
  function bind(name, value) {
    const key = symbol(name);
    // Monotone taint: repeated var declarations cannot oscillate the scan.
    if (!key || !value || bindings.has(key)) return false;
    bindings.set(key, value);
    return true;
  }
  function add(node, method, useKind) {
    let fingerprintNode = node;
    if (useKind === 'reference') {
      // Waive the actual acquisition/pass-through, not any same-named identifier.
      let parent = node.parent;
      while (parent && (ts.isAsExpression(parent) || ts.isParenthesizedExpression(parent) ||
        ts.isTypeAssertionExpression(parent) || ts.isNonNullExpression(parent))) parent = parent.parent;
      if (parent && (ts.isVariableDeclaration(parent) || ts.isParameter(parent) ||
          ts.isCallExpression(parent) || ts.isBinaryExpression(parent) || ts.isPropertyAssignment(parent))) {
        fingerprintNode = parent;
      }
    }
    uses.push({ file: file.replaceAll('\\', '/'),
      line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
      method, kind: useKind,
      fingerprint: createHash('sha256').update(normalizedTokens(fingerprintNode.getText(sf))).digest('hex') });
  }
  visit(sf, (node) => {
    if (ts.isImportEqualsDeclaration(node) && !node.isTypeOnly &&
        ts.isExternalModuleReference(node.moduleReference) &&
        PROCESS_MODULES.has(stringValue(node.moduleReference.expression))) {
      bind(node.name, 'namespace');
    }
    if (!ts.isImportDeclaration(node) || !PROCESS_MODULES.has(stringValue(node.moduleSpecifier))) return;
    const clause = node.importClause;
    if (!clause || clause.isTypeOnly) return;
    if (clause.name) bind(clause.name, 'namespace');
    const named = clause.namedBindings;
    if (named && ts.isNamespaceImport(named)) bind(named.name, 'namespace');
    if (named && ts.isNamedImports(named)) for (const specifier of named.elements) {
      const method = (specifier.propertyName ?? specifier.name).text;
      if (specifier.isTypeOnly || !SINKS.has(method)) continue;
      bind(specifier.name, method);
      add(specifier, method, 'import');
    }
  });
  // Fixed point resolves chains of aliases regardless of declaration order.
  for (let changed = true; changed;) {
    changed = false;
    visit(sf, (node) => {
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
          ts.isIdentifier(node.left)) changed = bind(node.left, kind(node.right)) || changed;
      if (!ts.isVariableDeclaration(node) && !ts.isParameter(node)) return;
      const value = kind(node.initializer);
      if (ts.isIdentifier(node.name)) changed = bind(node.name, value) || changed;
      if (value === 'namespace' && ts.isObjectBindingPattern(node.name)) {
        for (const entry of node.name.elements) {
          const key = entry.propertyName ?? entry.name;
          const method = ts.isIdentifier(key) ? key.text : stringValue(key);
          if (SINKS.has(method) && ts.isIdentifier(entry.name)) changed = bind(entry.name, method) || changed;
        }
      }
    });
  }
  function walkRuntime(node, suppressReference = false) {
    if (ts.isTypeNode(node) || ts.isImportDeclaration(node)) return;
    if (ts.isCallExpression(node) && SINKS.has(kind(node.expression))) {
      add(node, kind(node.expression), 'call');
      walkRuntime(node.expression, true);
      for (const argument of node.arguments) walkRuntime(argument);
      return;
    }
    const parent = node.parent;
    const declarationName = parent && parent.name === node &&
      (ts.isVariableDeclaration(parent) || ts.isBindingElement(parent) ||
        ts.isParameter(parent) || ts.isFunctionDeclaration(parent));
    const propertyName = parent && ts.isPropertyAccessExpression(parent) && parent.name === node;
    if (!suppressReference && !declarationName && !propertyName && SINKS.has(kind(node))) {
      add(node, kind(node), 'reference');
      // Member subtrees do not add another reference to this same use.
      ts.forEachChild(node, (child) => walkRuntime(child, true));
      return;
    }
    ts.forEachChild(node, (child) => walkRuntime(child, suppressReference));
  }
  walkRuntime(sf);
  return uses;
}

function keyOf(use) {
  return JSON.stringify([use.file, use.method, use.kind, use.fingerprint]);
}

/** Every exception is an exact source use, maximum count, and reviewed reason. */
export function checkAllowlist(uses, allowlist) {
  const errors = [];
  const counts = new Map();
  const allowed = new Map();
  for (const use of uses) {
    const key = keyOf(use);
    const group = counts.get(key) ?? { ...use, count: 0 };
    group.count++;
    counts.set(key, group);
  }
  for (const entry of allowlist) {
    const key = keyOf(entry);
    if (!entry.file?.startsWith('src/main/') || entry.file.includes('..') ||
        !SINKS.has(entry.method) || !['import', 'call', 'reference'].includes(entry.kind) ||
        !/^[a-f0-9]{64}$/.test(entry.fingerprint ?? '') ||
        !Number.isSafeInteger(entry.count) || entry.count < 1 ||
        typeof entry.reason !== 'string' || entry.reason.trim().length < 16) {
      errors.push(`invalid or unjustified exception: ${entry.file ?? '(missing file)'}`);
      continue;
    }
    if (allowed.has(key)) errors.push(`duplicate exception: ${entry.file}`);
    allowed.set(key, entry);
  }
  for (const [key, use] of counts) {
    const waiver = allowed.get(key);
    if (!waiver || use.count > waiver.count) {
      errors.push(`${use.file}:${use.line} new synchronous process ${use.method} (${use.kind}, count ${use.count})`);
    }
  }
  for (const [key, entry] of allowed) {
    if ((counts.get(key)?.count ?? 0) < entry.count) errors.push(`stale exception: ${entry.file} ${entry.method} — remove/shrink it`);
  }
  return errors;
}

export function scanMain(root = process.cwd()) {
  const uses = [];
  function walk(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!['node_modules', '__tests__', '__fixtures__'].includes(entry.name) && !entry.name.startsWith('.')) walk(candidate);
      } else if (entry.isFile() && EXTENSIONS.has(path.extname(entry.name)) && !/\.(test|spec)\.[^.]+$/.test(entry.name)) {
        uses.push(...findSyncProcessUses(fs.readFileSync(candidate, 'utf8'), path.relative(root, candidate)));
      }
    }
  }
  walk(path.join(root, 'src/main'));
  return uses;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const uses = scanMain();
    const policy = JSON.parse(fs.readFileSync('scripts/main-sync-allowlist.json', 'utf8'));
    if (policy.version !== 1 || !Array.isArray(policy.exceptions)) throw new Error('invalid Main Sync allowlist');
    const errors = checkAllowlist(uses, policy.exceptions);
    if (errors.length) {
      console.error(`main sync audit: ${errors.length} violation(s)`);
      for (const error of errors) console.error(`  ${error}`);
      process.exitCode = 1;
    } else {
      console.log(`main sync audit: no new synchronous processes; ${uses.length} exact legacy uses reviewed`);
    }
  } catch (error) {
    console.error(`main sync audit failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
