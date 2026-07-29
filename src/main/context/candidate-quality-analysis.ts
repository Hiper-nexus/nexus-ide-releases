import { createHash } from 'node:crypto';
import path from 'node:path';
import ts from 'typescript';
import type { ReviewFindingInput } from './review-council';
import {
  buildOrientationImportGraphFromFacts,
  extractOrientationImportSpecifiers,
  type OrientationImportFileFact,
} from './orientation/orientation-import-graph';
import type { OrientationLimits } from './orientation/orientation-types';

const TS_JS_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
]);
const TEST_FILE_RE = /(?:^|\/)(?:__tests__\/|[^/]+\.(?:test|spec)\.[^/]+$)/iu;
const GENERATED_FILE_RE = /(?:^|\/)(?:generated|dist|build|out)(?:\/|$)/iu;
const MAX_FINDINGS = 128;
const MIN_DUPLICATE_TOKENS = 20;
const MIN_DUPLICATE_TEXT = 100;
const BLAST_RADIUS_IMPORTERS = 4;
const PRIVILEGED_RENDERER_IMPORTS = new Set([
  'child_process',
  'cluster',
  'dgram',
  'electron',
  'fs',
  'http',
  'https',
  'module',
  'net',
  'os',
  'tls',
  'worker_threads',
]);
const GENERIC_API_NAMES = new Set([
  'build',
  'create',
  'get',
  'load',
  'make',
  'parse',
  'read',
  'render',
  'resolve',
  'run',
  'set',
  'update',
  'write',
]);
const GRAPH_LIMITS: OrientationLimits = Object.freeze({
  maxFiles: 4_000,
  maxFileBytes: 512 * 1024,
  maxTotalBytes: 24 * 1024 * 1024,
  maxDepth: 16,
  buildBudgetMs: 5_000,
  markdownMaxChars: 8_000,
  maxHubs: 24,
});

export interface CandidateQualityLineRange {
  readonly start: number;
  readonly end: number;
}

export interface CandidateQualitySourceFact {
  readonly relativePath: string;
  readonly content: string;
  readonly addedLines: readonly CandidateQualityLineRange[];
}

export interface CandidateQualityFactInput {
  readonly changedFiles: readonly string[];
  readonly sources: readonly CandidateQualitySourceFact[];
}

interface ParsedSource {
  readonly fact: CandidateQualitySourceFact;
  readonly sourceFile: ts.SourceFile;
}

interface FunctionFact {
  readonly file: string;
  readonly line: number;
  readonly name: string;
  readonly exported: boolean;
  readonly signature: string;
  readonly bodyHash: string | null;
  readonly bodyTokenCount: number;
}

function normalizeRelativePath(value: string): string | null {
  if (!value || /[\0\r\n\\]/u.test(value)) return null;
  const normalized = path.posix.normalize(value);
  if (
    normalized === '.' ||
    normalized === '..' ||
    normalized.startsWith('../') ||
    path.posix.isAbsolute(normalized)
  ) {
    return null;
  }
  return normalized;
}

function scriptKind(relativePath: string): ts.ScriptKind {
  switch (path.posix.extname(relativePath).toLowerCase()) {
    case '.tsx':
      return ts.ScriptKind.TSX;
    case '.jsx':
      return ts.ScriptKind.JSX;
    case '.js':
    case '.mjs':
    case '.cjs':
      return ts.ScriptKind.JS;
    default:
      return ts.ScriptKind.TS;
  }
}

function lineFor(sourceFile: ts.SourceFile, node: ts.Node): number {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

function lineWasAdded(fact: CandidateQualitySourceFact, line: number): boolean {
  return fact.addedLines.some((range) => line >= range.start && line <= range.end);
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return (
    ts.canHaveModifiers(node) &&
    (ts.getModifiers(node)?.some((modifier) => modifier.kind === kind) ?? false)
  );
}

function finding(input: ReviewFindingInput): ReviewFindingInput {
  return Object.freeze({
    ...input,
    criterionRefs: Object.freeze([...input.criterionRefs]),
    invariantRefs: Object.freeze([...input.invariantRefs]),
  });
}

function unreachableFindings(parsed: ParsedSource): ReviewFindingInput[] {
  const findings: ReviewFindingInput[] = [];
  const inspect = (node: ts.Node): void => {
    if (ts.isBlock(node)) {
      let terminal: ts.Statement | null = null;
      for (const statement of node.statements) {
        if (terminal) {
          const line = lineFor(parsed.sourceFile, statement);
          // Function declarations are hoisted and can be intentionally placed
          // after a return while still being callable before it.
          if (
            !ts.isFunctionDeclaration(statement) &&
            lineWasAdded(parsed.fact, line)
          ) {
            findings.push(finding({
              severity: 'high',
              category: 'correctness',
              file: parsed.fact.relativePath,
              line,
              criterionRefs: [],
              invariantRefs: ['reachable-production-code'],
              evidence:
                `New statement is unreachable because an unconditional ` +
                `${ts.SyntaxKind[terminal.kind]} ends the same block first.`,
              recommendation:
                'Remove the unreachable statement or restructure the control flow and add a focused regression test.',
            }));
            break;
          }
        }
        if (
          ts.isReturnStatement(statement) ||
          ts.isThrowStatement(statement) ||
          ts.isBreakStatement(statement) ||
          ts.isContinueStatement(statement)
        ) {
          terminal = statement;
        }
      }
    }
    ts.forEachChild(node, inspect);
  };
  inspect(parsed.sourceFile);
  return findings;
}

function importedModules(
  sourceFile: ts.SourceFile,
): readonly { readonly specifier: string; readonly line: number }[] {
  const imports: Array<{ specifier: string; line: number }> = [];
  const inspect = (node: ts.Node): void => {
    let literal: ts.StringLiteralLike | null = null;
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      literal = node.moduleSpecifier;
    } else if (
      ts.isCallExpression(node) &&
      node.arguments.length === 1 &&
      ts.isStringLiteralLike(node.arguments[0]!) &&
      (
        node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require')
      )
    ) {
      literal = node.arguments[0]!;
    }
    if (literal) {
      imports.push({
        specifier: literal.text,
        line: lineFor(sourceFile, node),
      });
    }
    ts.forEachChild(node, inspect);
  };
  inspect(sourceFile);
  return Object.freeze(imports);
}

function resolvesInto(relativePath: string, specifier: string, boundary: string): boolean {
  if (!specifier.startsWith('.')) {
    return specifier === boundary || specifier.startsWith(`${boundary}/`);
  }
  const resolved = path.posix.normalize(
    path.posix.join(path.posix.dirname(relativePath), specifier),
  );
  return resolved === boundary || resolved.startsWith(`${boundary}/`);
}

function architectureFindings(parsed: ParsedSource): ReviewFindingInput[] {
  const relativePath = parsed.fact.relativePath;
  const isRenderer = relativePath.startsWith('src/renderer/');
  const isShared = relativePath.startsWith('src/shared/');
  const isMain = relativePath.startsWith('src/main/');
  if (!isRenderer && !isShared && !isMain) return [];
  const findings: ReviewFindingInput[] = [];
  for (const imported of importedModules(parsed.sourceFile)) {
    if (!lineWasAdded(parsed.fact, imported.line)) continue;
    const bare = imported.specifier.replace(/^node:/u, '').split('/', 1)[0] ?? '';
    const rendererPrivilege =
      isRenderer &&
      (
        imported.specifier.startsWith('node:') ||
        PRIVILEGED_RENDERER_IMPORTS.has(bare) ||
        resolvesInto(relativePath, imported.specifier, 'src/main') ||
        resolvesInto(relativePath, imported.specifier, 'src/preload')
      );
    const sharedBoundary =
      isShared &&
      (
        imported.specifier.startsWith('node:') ||
        PRIVILEGED_RENDERER_IMPORTS.has(bare) ||
        ['src/main', 'src/renderer', 'src/preload'].some((boundary) =>
          resolvesInto(relativePath, imported.specifier, boundary))
      );
    const mainBoundary =
      isMain && resolvesInto(relativePath, imported.specifier, 'src/renderer');
    if (!rendererPrivilege && !sharedBoundary && !mainBoundary) continue;
    findings.push(finding({
      severity: rendererPrivilege ? 'critical' : 'high',
      category: rendererPrivilege ? 'security' : 'correctness',
      file: relativePath,
      line: imported.line,
      criterionRefs: [],
      invariantRefs: ['process-boundary-isolation'],
      evidence:
        `New import "${imported.specifier}" crosses the ${isRenderer ? 'renderer' : isShared ? 'shared' : 'main'} process boundary.`,
      recommendation:
        'Move the capability behind a typed preload/IPC or shared contract boundary instead of importing privileged implementation code.',
    }));
  }
  return findings;
}

function bodyFingerprint(
  sourceFile: ts.SourceFile,
  body: ts.ConciseBody | undefined,
): { hash: string | null; tokens: number } {
  if (!body) return { hash: null, tokens: 0 };
  const text = body.getText(sourceFile);
  if (text.length < MIN_DUPLICATE_TEXT) return { hash: null, tokens: 0 };
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    true,
    sourceFile.languageVariant,
    text,
  );
  const tokens: string[] = [];
  for (
    let token = scanner.scan();
    token !== ts.SyntaxKind.EndOfFileToken;
    token = scanner.scan()
  ) {
    tokens.push(scanner.getTokenText());
  }
  if (tokens.length < MIN_DUPLICATE_TOKENS) {
    return { hash: null, tokens: tokens.length };
  }
  return {
    hash: createHash('sha256').update(tokens.join('\0')).digest('hex'),
    tokens: tokens.length,
  };
}

function signatureFor(
  sourceFile: ts.SourceFile,
  parameters: readonly ts.ParameterDeclaration[],
  returnType: ts.TypeNode | undefined,
): string {
  const params = parameters.map((parameter) => {
    const type = parameter.type?.getText(sourceFile).replace(/\s+/gu, '') ?? '?';
    return `${parameter.dotDotDotToken ? 'rest:' : ''}${parameter.questionToken || parameter.initializer ? 'optional:' : ''}${type}`;
  });
  const result = returnType?.getText(sourceFile).replace(/\s+/gu, '') ?? '?';
  return `${params.join(',')}=>${result}`;
}

function collectFunctions(parsed: ParsedSource): FunctionFact[] {
  const functions: FunctionFact[] = [];
  for (const statement of parsed.sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name) {
      const body = bodyFingerprint(parsed.sourceFile, statement.body);
      functions.push({
        file: parsed.fact.relativePath,
        line: lineFor(parsed.sourceFile, statement),
        name: statement.name.text,
        exported: hasModifier(statement, ts.SyntaxKind.ExportKeyword),
        signature: signatureFor(
          parsed.sourceFile,
          statement.parameters,
          statement.type,
        ),
        bodyHash: body.hash,
        bodyTokenCount: body.tokens,
      });
      continue;
    }
    if (!ts.isVariableStatement(statement)) continue;
    const exported = hasModifier(statement, ts.SyntaxKind.ExportKeyword);
    for (const declaration of statement.declarationList.declarations) {
      if (
        !ts.isIdentifier(declaration.name) ||
        !declaration.initializer ||
        (
          !ts.isArrowFunction(declaration.initializer) &&
          !ts.isFunctionExpression(declaration.initializer)
        )
      ) {
        continue;
      }
      const callable = declaration.initializer;
      const body = bodyFingerprint(parsed.sourceFile, callable.body);
      functions.push({
        file: parsed.fact.relativePath,
        line: lineFor(parsed.sourceFile, statement),
        name: declaration.name.text,
        exported,
        signature: signatureFor(
          parsed.sourceFile,
          callable.parameters,
          callable.type,
        ),
        bodyHash: body.hash,
        bodyTokenCount: body.tokens,
      });
    }
  }
  return functions;
}

function apiNameTokens(name: string): readonly string[] {
  return Object.freeze(
    name
      .replace(/([a-z0-9])([A-Z])/gu, '$1 $2')
      .replace(/([A-Z]+)([A-Z][a-z])/gu, '$1 $2')
      .split(/[^A-Za-z0-9]+/u)
      .map((token) => token.toLowerCase())
      .filter(Boolean)
      .map((token) =>
        token.length > 4 && token.endsWith('s') ? token.slice(0, -1) : token),
  );
}

function similarApiName(left: string, right: string): boolean {
  if (left === right) {
    return left.length >= 8 && !GENERIC_API_NAMES.has(left.toLowerCase());
  }
  const leftTokens = new Set(apiNameTokens(left));
  const rightTokens = new Set(apiNameTokens(right));
  if (leftTokens.size < 3 || rightTokens.size < 3) return false;
  const intersection = [...leftTokens].filter((token) => rightTokens.has(token));
  const union = new Set([...leftTokens, ...rightTokens]);
  return intersection.length / union.size >= 0.75;
}

function structuralFindings(
  parsedSources: readonly ParsedSource[],
  changedFiles: ReadonlySet<string>,
): ReviewFindingInput[] {
  const functions = parsedSources
    .filter((parsed) => !TEST_FILE_RE.test(parsed.fact.relativePath))
    .flatMap(collectFunctions);
  const identifiers = new Map<string, number>();
  for (const parsed of parsedSources) {
    const inspect = (node: ts.Node): void => {
      if (ts.isIdentifier(node)) {
        identifiers.set(node.text, (identifiers.get(node.text) ?? 0) + 1);
      }
      ts.forEachChild(node, inspect);
    };
    inspect(parsed.sourceFile);
  }

  const findings: ReviewFindingInput[] = [];
  for (const candidate of functions) {
    const parsed = parsedSources.find(
      (source) => source.fact.relativePath === candidate.file,
    );
    if (
      !parsed ||
      !changedFiles.has(candidate.file) ||
      !lineWasAdded(parsed.fact, candidate.line)
    ) {
      continue;
    }
    if (!candidate.exported && (identifiers.get(candidate.name) ?? 0) === 1) {
      findings.push(finding({
        severity: 'medium',
        category: 'correctness',
        file: candidate.file,
        line: candidate.line,
        criterionRefs: [],
        invariantRefs: ['no-dead-code'],
        evidence:
          `Unreferenced local function "${candidate.name}" appears only at its declaration in the bounded project index.`,
        recommendation:
          'Delete it or integrate it through an explicit caller and cover that behavior with a focused test.',
      }));
    }
    if (candidate.bodyHash) {
      const duplicate = functions.find(
        (other) =>
          other !== candidate &&
          other.file !== candidate.file &&
          other.bodyHash === candidate.bodyHash,
      );
      if (duplicate) {
        findings.push(finding({
          severity: 'medium',
          category: 'correctness',
          file: candidate.file,
          line: candidate.line,
          criterionRefs: [],
          invariantRefs: ['single-source-of-truth'],
          evidence:
            `Duplicate implementation (${candidate.bodyTokenCount} tokens) matches ` +
            `${duplicate.file}:${duplicate.line}.`,
          recommendation:
            'Reuse the existing implementation or extract one shared domain function with one test contract.',
        }));
      }
    }
    if (!candidate.exported) continue;
    const similar = functions.find(
      (other) =>
        other !== candidate &&
        other.file !== candidate.file &&
        other.exported &&
        other.signature === candidate.signature &&
        similarApiName(candidate.name, other.name),
    );
    if (similar) {
      findings.push(finding({
        severity: 'medium',
        category: 'correctness',
        file: candidate.file,
        line: candidate.line,
        criterionRefs: [],
        invariantRefs: ['single-source-of-truth'],
        evidence:
          `Similar exported API "${candidate.name}" has the same signature as ` +
          `"${similar.name}" in ${similar.file}:${similar.line}.`,
        recommendation:
          'Confirm the domain distinction; otherwise consolidate the API or make the naming/contract difference explicit.',
      }));
    }
  }
  return findings;
}

function hasExecutableTopLevel(sourceFile: ts.SourceFile): boolean {
  return sourceFile.statements.some(
    (statement) =>
      ts.isFunctionDeclaration(statement) ||
      ts.isClassDeclaration(statement) ||
      (
        ts.isVariableStatement(statement) &&
        statement.declarationList.declarations.some(
          (declaration) => declaration.initializer !== undefined,
        )
      ),
  );
}

function coverageAndBlastRadiusFindings(
  parsedSources: readonly ParsedSource[],
  changedFiles: ReadonlySet<string>,
): ReviewFindingInput[] {
  const importFacts: OrientationImportFileFact[] = parsedSources.map((parsed) =>
    Object.freeze({
      relativePath: parsed.fact.relativePath,
      ext: path.posix.extname(parsed.fact.relativePath).toLowerCase(),
      size: Buffer.byteLength(parsed.fact.content, 'utf8'),
      importSpecifiers: extractOrientationImportSpecifiers(parsed.fact.content),
    }));
  const graph = buildOrientationImportGraphFromFacts(importFacts, GRAPH_LIMITS);
  const sourcePaths = new Set(parsedSources.map((source) => source.fact.relativePath));
  const findings: ReviewFindingInput[] = [];

  for (const parsed of parsedSources) {
    const file = parsed.fact.relativePath;
    if (
      !changedFiles.has(file) ||
      TEST_FILE_RE.test(file) ||
      GENERATED_FILE_RE.test(file) ||
      file.endsWith('.d.ts') ||
      parsed.fact.addedLines.length === 0 ||
      !hasExecutableTopLevel(parsed.sourceFile)
    ) {
      continue;
    }
    const importers = graph.reverse.get(file) ?? [];
    const testImporters = importers.filter((importer) => TEST_FILE_RE.test(importer));
    const stem = file.replace(/\.[^.]+$/u, '');
    const hasMappedTest =
      testImporters.length > 0 ||
      [...sourcePaths].some(
        (candidate) =>
          TEST_FILE_RE.test(candidate) &&
          (
            candidate.startsWith(`${stem}.`) ||
            path.posix.basename(candidate).startsWith(
              `${path.posix.basename(stem)}.`,
            )
          ),
      );
    if (!hasMappedTest) {
      findings.push(finding({
        severity: 'medium',
        category: 'correctness',
        file,
        line: parsed.fact.addedLines[0]?.start,
        criterionRefs: [],
        invariantRefs: ['tested-change'],
        evidence:
          'Test coverage gap: changed executable source has no co-located or importing test in the bounded candidate index.',
        recommendation:
          'Add a focused unit/integration test and include line-coverage evidence for the changed behavior.',
      }));
    }
    const productionImporters = importers.filter(
      (importer) => !TEST_FILE_RE.test(importer),
    );
    const untouchedImporters = productionImporters.filter(
      (importer) => !changedFiles.has(importer),
    );
    if (
      productionImporters.length >= BLAST_RADIUS_IMPORTERS &&
      untouchedImporters.length === productionImporters.length
    ) {
      findings.push(finding({
        severity: 'medium',
        category: 'correctness',
        file,
        line: parsed.fact.addedLines[0]?.start,
        criterionRefs: [],
        invariantRefs: ['blast-radius-reviewed'],
        evidence:
          `Blast radius: ${productionImporters.length} production files import this changed module, ` +
          `but no importer is changed; examples: ${productionImporters.slice(0, 3).join(', ')}.`,
        recommendation:
          'Verify compatibility at each public contract edge and add an integration test covering representative consumers.',
      }));
    }
  }
  return findings;
}

function findingKey(value: ReviewFindingInput): string {
  return [
    value.severity,
    value.category,
    value.file,
    value.line ?? 0,
    value.evidence,
  ].join('\0');
}

export function analyzeCandidateQualityFacts(
  input: CandidateQualityFactInput,
): readonly ReviewFindingInput[] {
  const changedFiles = new Set(
    input.changedFiles
      .map(normalizeRelativePath)
      .filter((value): value is string => value !== null),
  );
  const parsedSources: ParsedSource[] = [];
  for (const fact of input.sources) {
    const relativePath = normalizeRelativePath(fact.relativePath);
    if (
      !relativePath ||
      !TS_JS_EXTENSIONS.has(path.posix.extname(relativePath).toLowerCase()) ||
      GENERATED_FILE_RE.test(relativePath)
    ) {
      continue;
    }
    const normalizedFact = Object.freeze({
      ...fact,
      relativePath,
      addedLines: Object.freeze(
        fact.addedLines
          .filter(
            (range) =>
              Number.isSafeInteger(range.start) &&
              Number.isSafeInteger(range.end) &&
              range.start > 0 &&
              range.end >= range.start,
          )
          .map((range) => Object.freeze({ ...range })),
      ),
    });
    parsedSources.push(Object.freeze({
      fact: normalizedFact,
      sourceFile: ts.createSourceFile(
        relativePath,
        normalizedFact.content,
        ts.ScriptTarget.Latest,
        true,
        scriptKind(relativePath),
      ),
    }));
  }

  const findings = [
    ...parsedSources
      .filter(
        (parsed) =>
          changedFiles.has(parsed.fact.relativePath) &&
          !TEST_FILE_RE.test(parsed.fact.relativePath),
      )
      .flatMap((parsed) => [
        ...architectureFindings(parsed),
        ...unreachableFindings(parsed),
      ]),
    ...structuralFindings(parsedSources, changedFiles),
    ...coverageAndBlastRadiusFindings(parsedSources, changedFiles),
  ];
  const unique = new Map<string, ReviewFindingInput>();
  for (const value of findings) {
    unique.set(findingKey(value), value);
    if (unique.size >= MAX_FINDINGS) break;
  }
  return Object.freeze([...unique.values()]);
}
