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

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** Teto de módulos de produção que ainda contam como "patch cirúrgico". */
export const SURGICAL_PRODUCTION_MODULE_LIMIT = 1;

/** A fast lane é sempre OPT-IN explícito do operador. */
export const RELEASE_FAST_LANE_ENV = 'NEXUS_RELEASE_FAST_LANE';

/** Nome do documento durável de waiver dentro do securityDir. */
export const FAST_LANE_WAIVER_ASSET = 'release-fast-lane-waiver.json';

/** O que a fast lane roda DE VERDADE no lugar da missão real empacotada. */
const FAST_LANE_PROOFS = Object.freeze([
  'verify-macos-release',
  'candidate-artifact-seal',
  'packaged-smoke',
]);

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

function sha256Buffer(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

/**
 * Nomes de evidência E2E declarados pelo recibo baseline. A fast lane preserva
 * exatamente esses bytes: eles são a prova que está sendo REUSADA, então
 * precisam sobreviver ao wipe do securityDir e ser re-hashados no publish.
 */
function baselineEvidenceNames(receipt) {
  return [
    receipt?.artifacts?.e2eEvidence,
    receipt?.artifacts?.e2eEvidenceClaudeOrchestrator,
  ]
    .filter((entry) => entry && typeof entry.name === 'string')
    .map((entry) => ({ name: entry.name, sha256: entry.sha256 }));
}

function readBaselineEvidence(securityDir, receipt) {
  return baselineEvidenceNames(receipt).map((declared) => {
    if (path.basename(declared.name) !== declared.name) {
      throw new Error(`baseline evidence name escapes the security dir: ${declared.name}`);
    }
    const bytes = fs.readFileSync(path.join(securityDir, declared.name));
    const observed = sha256Buffer(bytes);
    if (observed !== declared.sha256) {
      throw new Error(
        `baseline E2E evidence bytes diverge from the green receipt: ${declared.name}`,
      );
    }
    return Object.freeze({ name: declared.name, sha256: observed, bytes });
  });
}

function planFullGate(reason) {
  return Object.freeze({
    lane: 'full',
    reason,
    changedPaths: [],
    productionModules: [],
    disqualifiers: [],
    waiver: null,
    baselineReceipt: null,
    baselineEvidence: [],
  });
}

/**
 * Resolve a faixa do ciclo ATUAL lendo o recibo verde que ainda está no
 * securityDir — o gate apaga esse diretório logo em seguida, então o plano
 * (incluindo os BYTES da evidência reusada) tem que ser tirado antes.
 *
 * Nunca lança: qualquer defeito vira `full`, que é o comportamento de hoje.
 */
export function planReleaseFastLane({
  securityDir,
  environment = process.env,
  gitCapture,
} = {}) {
  if (environment?.[RELEASE_FAST_LANE_ENV] !== '1') {
    return planFullGate(
      `fast lane not requested (${RELEASE_FAST_LANE_ENV} is not "1")`,
    );
  }
  let baselineReceipt = null;
  let baselineEvidence = [];
  let changedPaths = [];
  try {
    baselineReceipt = JSON.parse(
      fs.readFileSync(
        path.join(securityDir, 'release-candidate-receipt.json'),
        'utf8',
      ),
    );
    baselineEvidence = readBaselineEvidence(securityDir, baselineReceipt);
    changedPaths = collectReleaseChangedPaths({
      baselineCommitSha: baselineReceipt?.commitSha,
      gitCapture,
    });
  } catch (error) {
    return planFullGate(
      `fast lane baseline unusable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const decision = qualifyReleaseFastLane({
    changedPaths,
    baseline: baselineReceipt,
  });
  if (decision.lane === 'full') return planFullGate(decision.reason);
  return Object.freeze({
    ...decision,
    baselineReceipt,
    baselineEvidence: Object.freeze(baselineEvidence),
  });
}

/**
 * Documento durável do waiver. Ele é o registro honesto: diz o que NÃO rodou,
 * contra qual baseline verde, com que delta classificado, e o que rodou no
 * lugar. Vira asset de segurança e o publish o re-verifica antes de aceitar.
 */
export function buildFastLaneWaiverDocument({ plan, candidate, now } = {}) {
  if (!plan || plan.lane === 'full' || !plan.baselineReceipt) {
    throw new Error('cannot build a fast lane waiver for the full gate');
  }
  const clock = now ?? (() => new Date());
  return Object.freeze({
    schemaVersion: 1,
    lane: plan.lane,
    reason: plan.reason,
    qualifiedAt: clock().toISOString(),
    candidate: Object.freeze({
      version: candidate.version,
      commitSha: candidate.commitSha,
      zipSha256: candidate.zipSha256,
      dmgSha256: candidate.dmgSha256,
    }),
    baseline: Object.freeze({
      version: plan.baselineReceipt.version,
      commitSha: plan.baselineReceipt.commitSha,
      zipSha256: plan.baselineReceipt.artifacts.zip.sha256,
      evidence: Object.freeze(
        plan.baselineEvidence.map((entry) =>
          Object.freeze({ name: entry.name, sha256: entry.sha256 }),
        ),
      ),
    }),
    changedPaths: Object.freeze([...plan.changedPaths]),
    productionModules: Object.freeze([...plan.productionModules]),
    waivedProofs: Object.freeze(['physical-real-mission-product-wizard']),
    provedInstead: FAST_LANE_PROOFS,
  });
}

/**
 * Re-verifica um waiver contra o candidate atual e contra os BYTES da
 * evidência reusada que estão no securityDir. Fail-closed: qualquer divergência
 * lança, e o chamador (gate ou publish) reprova a release.
 */
export function assertFastLaneWaiverDocument(document, { securityDir, candidate } = {}) {
  if (
    document?.schemaVersion !== 1 ||
    (document.lane !== 'surgical' && document.lane !== 'reuse-green')
  ) {
    throw new Error('fast lane waiver has an unsupported shape');
  }
  if (
    document.candidate?.version !== candidate?.version ||
    document.candidate?.commitSha !== candidate?.commitSha ||
    document.candidate?.zipSha256 !== candidate?.zipSha256 ||
    document.candidate?.dmgSha256 !== candidate?.dmgSha256
  ) {
    throw new Error('fast lane waiver is not bound to this candidate');
  }
  if (
    !/^[0-9a-f]{40}$/u.test(document.baseline?.commitSha ?? '') ||
    document.baseline?.commitSha === candidate.commitSha ||
    !Array.isArray(document.baseline?.evidence) ||
    document.baseline.evidence.length === 0
  ) {
    throw new Error('fast lane waiver does not name a distinct green baseline');
  }
  for (const declared of document.baseline.evidence) {
    if (
      typeof declared?.name !== 'string' ||
      path.basename(declared.name) !== declared.name
    ) {
      throw new Error('fast lane waiver names an unsafe evidence asset');
    }
    const observed = sha256Buffer(
      fs.readFileSync(path.join(securityDir, declared.name)),
    );
    if (observed !== declared.sha256) {
      throw new Error(
        `reused E2E evidence bytes changed after the waiver: ${declared.name}`,
      );
    }
  }
  const reclassified = qualifyReleaseFastLane({
    changedPaths: document.changedPaths,
    baseline: {
      schemaVersion: 4,
      version: document.baseline.version,
      commitSha: document.baseline.commitSha,
      artifacts: {
        zip: { sha256: document.baseline.zipSha256 },
        e2eEvidence: { sha256: document.baseline.evidence[0].sha256 },
      },
      verification: { realMissionE2E: true, physicalProductWizard: true },
    },
  });
  if (reclassified.lane !== document.lane) {
    throw new Error(
      `fast lane waiver claims lane ${document.lane} but its own diff classifies as ${reclassified.lane}`,
    );
  }
  return document;
}
