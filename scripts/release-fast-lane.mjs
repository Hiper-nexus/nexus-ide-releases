/**
 * Fast lane de hotfix do gate de release.
 *
 * O gate completo custa ~40 min porque roda a missão real empacotada. Num
 * hotfix cirúrgico sobre um candidate JÁ VERDE, reexecutar a missão inteira
 * prova de novo o que não mudou. Este módulo é o CLASSIFICADOR que decide, por
 * diff e só por diff, se o hotfix qualifica — e emite o waiver que o publish
 * registra (mesmo padrão do skip declarado da 0.20.4: reduzir o que a release
 * exige é legítimo, esconder falha de quem participou nunca é).
 *
 * Três faixas:
 *  - `reuse-green`: nada do delta pode alcançar o artefato empacotado ⇒ o gate
 *    verde anterior vale inteiro (só resta reverificar assinatura dos bytes).
 *  - `surgical`: no máximo UM módulo de produção (+ testes + bump de versão)
 *    ⇒ reusa a evidência de missão do baseline, mas exige artefato novo
 *    verificado + smoke empacotado + smokes user-facing.
 *  - `full`: qualquer outra coisa. É o default de TODO caminho duvidoso.
 *
 * Fail-closed por construção: caminho não previsto pelas regras declaradas
 * classifica como `gate-critical` e derruba a fast lane.
 */

/** Teto de módulos de produção que ainda contam como "patch cirúrgico". */
export const SURGICAL_PRODUCTION_MODULE_LIMIT = 1;

/**
 * Módulos que DEFINEM o próprio gate ou o contrato que ele observa. Mudou um
 * deles, a evidência antiga deixa de ser prova válida — sempre gate completo.
 */
const GATE_CONTRACT_MODULES = Object.freeze([
  'src/shared/real-mission-e2e-evidence.ts',
  'src/shared/failover-handoff.ts',
]);

/** Prefixos cuja mudança nunca pode ser dispensada por waiver. */
const GATE_CRITICAL_PREFIXES = Object.freeze([
  'build/',
  'third_party/',
  '.github/',
  'entitlements',
]);

const GATE_CRITICAL_EXACT = Object.freeze([
  'forge.config.ts',
  'LICENSE',
  'THIRD_PARTY_NOTICES.md',
  '.npmrc',
]);

/** Metadados de versão da release: forçam rebuild, mas não mudam produto. */
const VERSION_BUMP_PATHS = Object.freeze([
  'package.json',
  'package-lock.json',
  'server/package.json',
  'server/package-lock.json',
]);

const NON_PACKAGEABLE_PREFIXES = Object.freeze([
  'docs/',
  'scripts/spikes/',
  '.agents/',
]);

const NON_PACKAGEABLE_EXACT = Object.freeze(['CHANGELOG.md', 'README.md']);

/** Código de produto: compila para `.vite` e entra no bundle assinado. */
const PRODUCTION_PREFIXES = Object.freeze(['src/']);

const TEST_FILE_PATTERN = /(^|\/)[^/]+\.(test|spec)\.[cm]?[jt]sx?$/u;

export function normalizeReleasePath(rawPath) {
  if (typeof rawPath !== 'string') return '';
  return rawPath.trim().replaceAll('\\', '/').replace(/^\.\//u, '');
}

/**
 * Classifica UM caminho do diff. A ordem importa: gate-critical vence tudo,
 * depois teste/doc, depois metadados de versão, depois produto; o resto é
 * desconhecido e portanto gate-critical.
 */
export function classifyReleaseChangedPath(rawPath) {
  const filePath = normalizeReleasePath(rawPath);
  if (!filePath) return 'gate-critical';
  if (GATE_CONTRACT_MODULES.includes(filePath)) return 'gate-critical';
  if (GATE_CRITICAL_EXACT.includes(filePath)) return 'gate-critical';
  if (GATE_CRITICAL_PREFIXES.some((prefix) => filePath.startsWith(prefix))) {
    return 'gate-critical';
  }
  if (TEST_FILE_PATTERN.test(filePath)) return 'non-packageable';
  if (NON_PACKAGEABLE_EXACT.includes(filePath)) return 'non-packageable';
  if (NON_PACKAGEABLE_PREFIXES.some((prefix) => filePath.startsWith(prefix))) {
    return 'non-packageable';
  }
  // `scripts/` fora de spikes é a maquinaria da release: nunca dispensável.
  if (filePath.startsWith('scripts/')) return 'gate-critical';
  if (VERSION_BUMP_PATHS.includes(filePath)) return 'version-bump';
  if (PRODUCTION_PREFIXES.some((prefix) => filePath.startsWith(prefix))) {
    return 'production';
  }
  return 'gate-critical';
}

export function parseReleaseChangedPaths(stdout) {
  const seen = new Set();
  for (const line of String(stdout ?? '').split('\n')) {
    const normalized = normalizeReleasePath(line);
    if (normalized) seen.add(normalized);
  }
  return [...seen];
}

/**
 * Coleta o delta baseline..HEAD. `--no-renames` de propósito: um rename de
 * módulo de produção aparece como DOIS caminhos e derruba a fast lane, que é
 * exatamente o desfecho seguro.
 */
export function collectReleaseChangedPaths({ baselineCommitSha, gitCapture }) {
  if (!/^[0-9a-f]{40}$/u.test(String(baselineCommitSha ?? ''))) {
    throw new Error(
      'release fast lane requires a full 40-hex baseline commit sha',
    );
  }
  const result = gitCapture([
    'diff',
    '--name-only',
    '--no-renames',
    `${baselineCommitSha}..HEAD`,
  ]);
  return parseReleaseChangedPaths(result?.stdout ?? '');
}

function fullGate(reason, extra = {}) {
  return Object.freeze({
    lane: 'full',
    reason,
    changedPaths: [],
    productionModules: [],
    disqualifiers: [],
    waiver: null,
    ...extra,
  });
}

/**
 * Baseline aceitável = recibo de candidate VERDE, com missão real provada
 * fisicamente e SEM waiver próprio. Encadear waiver sobre waiver deixaria a
 * evidência de missão derivar arbitrariamente longe do binário publicado.
 */
function disqualifyBaseline(baseline) {
  if (!baseline || typeof baseline !== 'object') {
    return 'no green baseline candidate receipt available';
  }
  if (baseline.schemaVersion !== 4) {
    return `baseline receipt schema ${String(baseline.schemaVersion)} is not the supported version 4`;
  }
  if (baseline.verification?.fastLaneWaiver) {
    return 'baseline candidate was itself waived by a fast lane; waivers do not chain';
  }
  if (
    baseline.verification?.realMissionE2E !== true ||
    baseline.verification?.physicalProductWizard !== true
  ) {
    return 'baseline candidate never proved the physical real-mission E2E';
  }
  if (
    typeof baseline.commitSha !== 'string' ||
    !/^[0-9a-f]{40}$/u.test(baseline.commitSha) ||
    typeof baseline.artifacts?.zip?.sha256 !== 'string' ||
    typeof baseline.artifacts?.e2eEvidence?.sha256 !== 'string'
  ) {
    return 'baseline candidate receipt is missing its commit/artifact binding';
  }
  return null;
}

/**
 * Decide a faixa do ciclo atual. Nunca lança: um resultado `full` é sempre
 * uma resposta válida, e é o default de qualquer dúvida.
 */
export function qualifyReleaseFastLane({ changedPaths, baseline } = {}) {
  const baselineProblem = disqualifyBaseline(baseline);
  if (baselineProblem) return fullGate(baselineProblem);

  const paths = parseReleaseChangedPaths(
    Array.isArray(changedPaths) ? changedPaths.join('\n') : changedPaths,
  );
  const buckets = { 'non-packageable': [], 'version-bump': [], production: [], 'gate-critical': [] };
  for (const filePath of paths) {
    buckets[classifyReleaseChangedPath(filePath)].push(filePath);
  }
  const disqualifiers = buckets['gate-critical'];
  if (disqualifiers.length > 0) {
    return fullGate(
      `release machinery or unclassified paths changed: ${disqualifiers.join(', ')}`,
      { changedPaths: paths, disqualifiers },
    );
  }
  const productionModules = buckets.production;
  if (productionModules.length > SURGICAL_PRODUCTION_MODULE_LIMIT) {
    return fullGate(
      `${productionModules.length} production modules changed; the surgical lane allows at most ${SURGICAL_PRODUCTION_MODULE_LIMIT}`,
      { changedPaths: paths, productionModules },
    );
  }

  const packageableUntouched =
    productionModules.length === 0 && buckets['version-bump'].length === 0;
  if (packageableUntouched) {
    return Object.freeze({
      lane: 'reuse-green',
      reason:
        paths.length === 0
          ? 'tree is identical to the green candidate'
          : 'delta cannot reach the packaged artifact (docs, tests, spikes only)',
      changedPaths: paths,
      productionModules: [],
      disqualifiers: [],
      waiver: null,
    });
  }

  return Object.freeze({
    lane: 'surgical',
    reason:
      productionModules.length === 0
        ? 'only release version metadata changed; artifact must be rebuilt and re-verified'
        : `single surgical production module over a green candidate: ${productionModules[0]}`,
    changedPaths: paths,
    productionModules,
    disqualifiers: [],
    waiver: Object.freeze({
      lane: 'surgical',
      baselineVersion: baseline.version,
      baselineCommitSha: baseline.commitSha,
      baselineZipSha256: baseline.artifacts.zip.sha256,
      baselineEvidenceSha256: baseline.artifacts.e2eEvidence.sha256,
      changedPaths: Object.freeze([...paths]),
      productionModules: Object.freeze([...productionModules]),
    }),
  });
}
