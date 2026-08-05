import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import {
  assertReleaseRepositoryState,
  collectReleaseRepositoryState,
  readAndAssertReleaseAuthority,
} from './release-authority.mjs';
import {
  assertRealMissionReleaseEvidence,
  assertVerifiedRealMissionRuntimeProof,
} from './e2e-real-mission.mjs';
import { bootstrapPinnedNpm } from './make-release.mjs';
import {
  assertFastLaneWaiverDocument,
  FAST_LANE_WAIVER_ASSET,
} from './release-fast-lane.mjs';

const MAX_COMMAND_OUTPUT_BYTES = 64 * 1024 * 1024;

function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}

function parseJson(raw, label) {
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`${label} inválido: o comando não retornou JSON verificável`);
  }
}

function defaultRunCommand(args, root) {
  const executable = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const result = spawnSync(executable, args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: MAX_COMMAND_OUTPUT_BYTES,
    env: process.env,
  });
  if (result.error) throw result.error;
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

function runBootstrapCommand(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: 'utf8',
    maxBuffer: MAX_COMMAND_OUTPUT_BYTES,
    env: options.env,
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${path.basename(command)} ${args[0]} failed`);
  }
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

function releaseSecurityEnvironment(environment) {
  const allowed = new Set([
    'PATH',
    'HOME',
    'USER',
    'LOGNAME',
    'SHELL',
    'TMPDIR',
    'LANG',
    'LC_ALL',
    'TERM',
    'CI',
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'NO_PROXY',
  ]);
  return Object.fromEntries(
    Object.entries(environment).filter(
      ([key, value]) =>
        typeof value === 'string' &&
        (allowed.has(key) || key.startsWith('LC_')),
    ),
  );
}

function writeJson(filePath, value) {
  const content = `${JSON.stringify(value, null, 2)}\n`;
  fs.writeFileSync(filePath, content, { encoding: 'utf8', mode: 0o644 });
  return { bytes: Buffer.byteLength(content), sha256: sha256(content) };
}

function vulnerabilityTotal(audit) {
  const total = audit?.metadata?.vulnerabilities?.total;
  if (!Number.isSafeInteger(total) || total < 0) {
    throw new Error('audit de produção inválido: total de vulnerabilidades ausente');
  }
  return total;
}

function assertCommitSha(value) {
  if (!/^[a-f0-9]{40}$/u.test(value ?? '')) {
    throw new Error('commit SHA inválido: release exige vínculo exato ao Git');
  }
  return value;
}

function currentCommitSha(root) {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: root,
    encoding: 'utf8',
    env: process.env,
    shell: false,
    timeout: 15_000,
  });
  if (result.status !== 0) {
    throw new Error('não foi possível resolver o commit Git da release');
  }
  return assertCommitSha(result.stdout.trim());
}

function npmVersion(root) {
  const result = defaultRunCommand(['--version'], root);
  if (result.status !== 0 || !/^\d+\.\d+\.\d+/u.test(result.stdout.trim())) {
    throw new Error('não foi possível resolver a versão do npm');
  }
  return result.stdout.trim();
}

function runAudit(runCommand, args, label) {
  const result = runCommand(args);
  const audit = parseJson(result.stdout, `audit ${label}`);
  const total = vulnerabilityTotal(audit);
  if (result.status !== 0 || total !== 0) {
    throw new Error(
      `release bloqueada: ${label} tem ${total} ` +
        `vulnerabilidade${total === 1 ? '' : 's'}`,
    );
  }
  return { audit, total };
}

function runSbom(runCommand, args, label) {
  const result = runCommand(args);
  if (result.status !== 0) {
    const detail = result.stderr.trim().slice(0, 1_000);
    throw new Error(
      `geração do SBOM ${label} falhou${detail ? `: ${detail}` : ''}`,
    );
  }
  const sbom = parseJson(result.stdout, `SBOM CycloneDX ${label}`);
  if (sbom?.bomFormat !== 'CycloneDX' || !Array.isArray(sbom.components)) {
    throw new Error(`SBOM CycloneDX ${label} inválido: contrato mínimo ausente`);
  }
  return sbom;
}

export function buildReleaseSecurityArtifacts(options = {}) {
  const root = path.resolve(options.root ?? process.cwd());
  const outDir = path.resolve(
    options.outDir ?? path.join(root, 'release-artifacts', 'security'),
  );
  const runCommand = options.runCommand ?? ((args) => defaultRunCommand(args, root));
  const now = options.now ?? (() => new Date());
  const commitSha = assertCommitSha(
    options.commitSha ?? currentCommitSha(root),
  );
  const runtime = options.runtime ?? {
    node: process.version,
    npm: npmVersion(root),
  };
  const packageJson = parseJson(
    fs.readFileSync(path.join(root, 'package.json'), 'utf8'),
    'package.json',
  );
  if (
    typeof packageJson.name !== 'string' ||
    typeof packageJson.version !== 'string'
  ) {
    throw new Error('package.json inválido: name/version obrigatórios');
  }
  if (fs.existsSync(outDir) && fs.readdirSync(outDir).length > 0) {
    throw new Error('security output directory must be empty before generation');
  }
  const tagObjectSha = assertCommitSha(options.tagObjectSha);
  const tagSignatureVerified = options.tagSignatureVerified === true;
  const tagSignerFingerprint =
    options.tagSignerFingerprint === null ||
    options.tagSignerFingerprint === undefined
      ? null
      : String(options.tagSignerFingerprint).trim();
  if (
    (tagSignatureVerified && !tagSignerFingerprint) ||
    (!tagSignatureVerified && tagSignerFingerprint !== null)
  ) {
    throw new Error('security gate tag signature state is incoherent');
  }

  const productionAudit = runAudit(
    runCommand,
    ['audit', '--omit=dev', '--json'],
    'árvore de produção',
  );
  const productionSbom = runSbom(runCommand, [
    'sbom',
    '--omit=dev',
    '--package-lock-only',
    '--sbom-format=cyclonedx',
    '--sbom-type=application',
  ], 'de produção');
  const toolchainAudit = runAudit(
    runCommand,
    ['audit', '--json'],
    'build toolchain',
  );
  const toolchainSbom = runSbom(runCommand, [
    'sbom',
    '--package-lock-only',
    '--sbom-format=cyclonedx',
    '--sbom-type=application',
  ], 'da build toolchain');

  fs.mkdirSync(outDir, { recursive: true, mode: 0o755 });
  const auditName = 'audit-production.json';
  const sbomName = `nexus-${packageJson.version}.cdx.json`;
  const toolchainAuditName = 'audit-build-toolchain.json';
  const toolchainSbomName = `nexus-${packageJson.version}-toolchain.cdx.json`;
  const auditFile = writeJson(
    path.join(outDir, auditName),
    productionAudit.audit,
  );
  const sbomFile = writeJson(
    path.join(outDir, sbomName),
    productionSbom,
  );
  const toolchainAuditFile = writeJson(
    path.join(outDir, toolchainAuditName),
    toolchainAudit.audit,
  );
  const toolchainSbomFile = writeJson(
    path.join(outDir, toolchainSbomName),
    toolchainSbom,
  );
  const packageLockSha256 = sha256(
    fs.readFileSync(path.join(root, 'package-lock.json')),
  );
  const manifest = {
    schemaVersion: 3,
    generatedAt: now().toISOString(),
    package: { name: packageJson.name, version: packageJson.version },
    commitSha,
    tagObjectSha,
    tagSignerFingerprint,
    tagSignatureVerified,
    packageLockSha256,
    runtime,
    audit: {
      productionVulnerabilities: productionAudit.total,
      buildToolchainVulnerabilities: toolchainAudit.total,
    },
    files: [
      { name: auditName, ...auditFile },
      { name: sbomName, ...sbomFile },
      { name: toolchainAuditName, ...toolchainAuditFile },
      { name: toolchainSbomName, ...toolchainSbomFile },
    ],
  };
  writeJson(path.join(outDir, 'security-manifest.json'), manifest);
  return { outDir, manifest };
}

export function buildReleaseSecurityArtifactsWithPinnedNpm(options = {}) {
  const root = path.resolve(options.root ?? process.cwd());
  const nodeVersion = options.nodeVersion ?? process.version;
  const expectedNodeVersion = options.expectedNodeVersion;
  if (
    typeof expectedNodeVersion !== 'string' ||
    nodeVersion !== `v${expectedNodeVersion}`
  ) {
    throw new Error(
      `release security gate requires Node ${expectedNodeVersion ?? '<unconfigured>'}; ` +
        `found ${nodeVersion}`,
    );
  }
  const buildBase = fs.mkdtempSync(
    path.join(os.tmpdir(), 'nexus-release-security-npm-'),
  );
  fs.chmodSync(buildBase, 0o700);
  try {
    const execute = options.executeBootstrap ?? runBootstrapCommand;
    const pinnedNpm = bootstrapPinnedNpm({
      buildBase,
      version: options.npmVersion,
      expectedIntegrity: options.npmPackageIntegrity,
      execute,
      environment: releaseSecurityEnvironment(
        options.environment ?? process.env,
      ),
    });
    const runCommand = (args) => {
      const result = spawnSync(
        process.execPath,
        [pinnedNpm.npmCli, ...args],
        {
          cwd: root,
          encoding: 'utf8',
          maxBuffer: MAX_COMMAND_OUTPUT_BYTES,
          env: pinnedNpm.npmEnvironment,
          shell: false,
        },
      );
      if (result.error) throw result.error;
      return {
        status: result.status ?? 1,
        stdout: result.stdout ?? '',
        stderr: result.stderr ?? '',
      };
    };
    return buildReleaseSecurityArtifacts({
      ...options,
      root,
      runCommand,
      runtime: {
        node: nodeVersion,
        npm: options.npmVersion,
      },
    });
  } finally {
    fs.rmSync(buildBase, { recursive: true, force: true });
  }
}

export function assertReleaseSecurityManifest({
  root,
  securityDir,
  manifest,
  commitSha,
  version,
  tagObjectSha,
  tagSignerFingerprint,
  tagSignatureVerified,
}) {
  const resolvedRoot = path.resolve(root);
  const expectedLockSha256 = sha256(
    fs.readFileSync(path.join(resolvedRoot, 'package-lock.json')),
  );
  const packageJson = parseJson(
    fs.readFileSync(path.join(resolvedRoot, 'package.json'), 'utf8'),
    'package.json',
  );
  const expectedNpmVersion = /^npm@(\d+\.\d+\.\d+)$/u.exec(
    packageJson?.packageManager ?? '',
  )?.[1];
  const expectedNodeVersion = packageJson?.nexusRelease?.node;
  const expectedNames = new Set([
    'audit-production.json',
    'audit-build-toolchain.json',
    `nexus-${version}.cdx.json`,
    `nexus-${version}-toolchain.cdx.json`,
  ]);
  if (
    manifest?.schemaVersion !== 3 ||
    manifest?.package?.name !== 'nexus-ide' ||
    manifest?.package?.version !== version ||
    manifest?.commitSha !== commitSha ||
    manifest?.tagObjectSha !== tagObjectSha ||
    manifest?.tagSignerFingerprint !== tagSignerFingerprint ||
    manifest?.tagSignatureVerified !== tagSignatureVerified ||
    !/^\d+\.\d+\.\d+$/u.test(expectedNodeVersion ?? '') ||
    manifest?.runtime?.node !== `v${expectedNodeVersion}` ||
    !expectedNpmVersion ||
    manifest?.runtime?.npm !== expectedNpmVersion ||
    !Number.isFinite(Date.parse(manifest?.generatedAt ?? ''))
  ) {
    throw new Error(
      'security manifest does not match release commit/version/tag authority',
    );
  }
  if (manifest?.packageLockSha256 !== expectedLockSha256) {
    throw new Error('security manifest package-lock digest is stale or forged');
  }
  if (
    manifest?.audit?.productionVulnerabilities !== 0 ||
    manifest?.audit?.buildToolchainVulnerabilities !== 0
  ) {
    throw new Error('security manifest contains nonzero vulnerabilities');
  }
  if (
    !Array.isArray(manifest?.files) ||
    manifest.files.length !== expectedNames.size ||
    manifest.files.some(
      (entry) =>
        !entry ||
        !expectedNames.delete(entry.name) ||
        !Number.isSafeInteger(entry.bytes) ||
        entry.bytes < 0 ||
        !/^[a-f0-9]{64}$/u.test(entry.sha256 ?? ''),
    ) ||
    expectedNames.size !== 0
  ) {
    throw new Error('security manifest file inventory is incomplete');
  }
  if (
    manifest.releaseArtifacts !== undefined &&
    manifest?.verification?.physicalProductWizard !== true
  ) {
    throw new Error(
      'finalized security manifest lacks physical product-wizard authority',
    );
  }
  if (!securityDir) return manifest;

  for (const entry of manifest.files) {
    const filePath = path.join(path.resolve(securityDir), entry.name);
    const physical = hashFile(filePath);
    if (physical.bytes !== entry.bytes || physical.sha256 !== entry.sha256) {
      throw new Error(`security artifact digest mismatch: ${entry.name}`);
    }
    const parsed = parseJson(
      fs.readFileSync(filePath, 'utf8'),
      entry.name,
    );
    if (entry.name.endsWith('.cdx.json')) {
      if (parsed?.bomFormat !== 'CycloneDX' || !Array.isArray(parsed.components)) {
        throw new Error(`security SBOM is invalid: ${entry.name}`);
      }
    } else if (vulnerabilityTotal(parsed) !== 0) {
      throw new Error(`security audit is invalid or nonzero: ${entry.name}`);
    }
  }
  if (manifest.releaseArtifacts !== undefined) {
    if (
      typeof manifest?.releaseArtifacts?.e2eEvidence?.name !== 'string' ||
      typeof manifest?.releaseArtifacts?.zip?.sha256 !== 'string' ||
      typeof manifest?.releaseArtifacts?.signingIdentity !== 'string'
    ) {
      throw new Error(
        'finalized security manifest lacks physical product-wizard authority',
      );
    }
    const evidencePath = path.join(
      path.resolve(securityDir),
      manifest.releaseArtifacts.e2eEvidence.name,
    );
    const evidenceFile = hashFile(evidencePath);
    if (
      evidenceFile.bytes !== manifest.releaseArtifacts.e2eEvidence.bytes ||
      evidenceFile.sha256 !== manifest.releaseArtifacts.e2eEvidence.sha256
    ) {
      throw new Error('finalized physical E2E evidence digest mismatch');
    }
    let physicalEvidence;
    try {
      physicalEvidence = assertRealMissionReleaseEvidence(
        parseJson(
          fs.readFileSync(evidencePath, 'utf8'),
          'evidência E2E física',
        ),
      );
    } catch (error) {
      throw new Error(
        `finalized security manifest has no valid physical product-wizard evidence: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    if (
      physicalEvidence.release?.commitSha !== commitSha ||
      physicalEvidence.release?.appVersion !== version ||
      physicalEvidence.release?.artifact?.sha256 !==
        manifest.releaseArtifacts.zip.sha256 ||
      physicalEvidence.release?.artifact?.identity !==
        manifest.releaseArtifacts.signingIdentity
    ) {
      throw new Error(
        'finalized physical E2E evidence does not match security manifest authority',
      );
    }
  }
  return manifest;
}

function hashFile(filePath) {
  const bytes = fs.readFileSync(filePath);
  return {
    bytes: bytes.byteLength,
    sha256: sha256(bytes),
  };
}

function hasExactClaudeOrchestratorSkip(skippedOrchestrators) {
  return (
    Array.isArray(skippedOrchestrators) &&
    skippedOrchestrators.length === 1 &&
    skippedOrchestrators[0] === 'claude'
  );
}

export function buildFinalizedReleaseSecurityFields(options) {
  const isClaudeSkipped = hasExactClaudeOrchestratorSkip(
    options.skippedOrchestrators,
  );
  if (
    options.skippedOrchestrators !== undefined &&
    !isClaudeSkipped
  ) {
    throw new Error('invalid skipped release orchestrator declaration');
  }
  // Fast lane: a missão real empacotada NÃO rodou neste ciclo. O manifesto diz
  // isso na cara — `physicalProductWizard: false` — e carrega o waiver que
  // nomeia o baseline verde reusado. Fingir `true` aqui seria o único jeito de
  // a fast lane virar mentira, então é exatamente o que não se faz.
  const fastLane = options.fastLaneWaiver
    ? {
        physicalProductWizard: false,
        fastLaneWaiver: {
          lane: options.fastLaneWaiver.lane,
          baselineCommitSha: options.fastLaneWaiver.baseline.commitSha,
          baselineVersion: options.fastLaneWaiver.baseline.version,
          asset: options.fastLaneWaiverAsset,
        },
      }
    : { physicalProductWizard: true };
  if (isClaudeSkipped) {
    if (options.e2eEvidenceClaudeOrchestrator !== undefined) {
      throw new Error(
        'Claude orchestrator skip cannot include fabricated Claude evidence',
      );
    }
    return {
      verification: {
        ...fastLane,
        skippedOrchestrators: ['claude'],
      },
      releaseArtifacts: {
        signingIdentity: options.signingIdentity,
        dmg: options.dmg,
        zip: options.zip,
        e2eEvidence: options.e2eEvidence,
      },
    };
  }
  if (options.e2eEvidenceClaudeOrchestrator === undefined) {
    throw new Error(
      'Claude orchestrator evidence and runtime proof are required',
    );
  }
  return {
    verification: {
      ...fastLane,
      physicalClaudeOrchestrator: !options.fastLaneWaiver,
    },
    releaseArtifacts: {
      signingIdentity: options.signingIdentity,
      dmg: options.dmg,
      zip: options.zip,
      e2eEvidence: options.e2eEvidence,
      e2eEvidenceClaudeOrchestrator:
        options.e2eEvidenceClaudeOrchestrator,
    },
  };
}

export function finalizeReleaseSecurityArtifacts(options) {
  const securityDir = path.resolve(options.securityDir);
  const manifestPath = path.join(securityDir, 'security-manifest.json');
  const manifest = parseJson(
    fs.readFileSync(manifestPath, 'utf8'),
    'security-manifest.json',
  );
  const commitSha = assertCommitSha(options.commitSha);
  assertReleaseSecurityManifest({
    root: options.root,
    securityDir,
    manifest,
    commitSha,
    version: options.version,
    tagObjectSha: options.tagObjectSha,
    tagSignerFingerprint: options.tagSignerFingerprint,
    tagSignatureVerified: options.tagSignatureVerified,
  });
  const dmg = hashFile(options.dmgPath);
  const zip = hashFile(options.zipPath);
  // Fast lane: a evidência reusada pertence, por construção, ao commit/ZIP do
  // BASELINE verde — não a este. O waiver é a única autoridade que autoriza
  // essa divergência, e ele é re-verificado aqui (binding do candidate novo,
  // bytes da evidência no disco e reclassificação do próprio diff).
  const waiver = options.fastLaneWaiver ?? null;
  if (waiver) {
    assertFastLaneWaiverDocument(waiver, {
      securityDir,
      candidate: {
        version: options.version,
        commitSha,
        zipSha256: zip.sha256,
        dmgSha256: dmg.sha256,
      },
    });
  }
  const evidenceBinding = waiver
    ? {
        commitSha: waiver.baseline.commitSha,
        appVersion: waiver.baseline.version,
        zipSha256: waiver.baseline.zipSha256,
      }
    : { commitSha, appVersion: options.version, zipSha256: zip.sha256 };
  let evidence;
  try {
    evidence = assertRealMissionReleaseEvidence(
      parseJson(
        fs.readFileSync(options.evidencePath, 'utf8'),
        'evidência E2E',
      ),
    );
  } catch (error) {
    throw new Error(
      `real mission evidence is incomplete or not a PASS: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (
    evidence?.status !== 'pass' ||
    evidence?.launchSurface !== 'product-wizard' ||
    evidence?.wizardCoverage !== 'main-owned-product-sequence' ||
    evidence?.release?.commitSha !== evidenceBinding.commitSha ||
    evidence?.release?.appVersion !== evidenceBinding.appVersion ||
    evidence?.release?.artifact?.identity !== options.expectedSigningIdentity
  ) {
    throw new Error(
      'evidência E2E não pertence ao mesmo commit/versão/identidade',
    );
  }
  if (!waiver) {
    assertVerifiedRealMissionRuntimeProof(options.runtimeProof, {
      evidence,
      releaseBinding: {
        appVersion: options.version,
        commitSha,
        artifact: {
          sha256: options.expectedE2EArtifactSha256,
          identity: options.expectedSigningIdentity,
        },
      },
    });
  } else if (options.runtimeProof !== undefined) {
    throw new Error(
      'fast lane waiver cannot carry a live runtime proof it did not produce',
    );
  }
  if (
    zip.sha256 !== options.expectedE2EArtifactSha256 ||
    evidence?.release?.artifact?.sha256 !== evidenceBinding.zipSha256
  ) {
    throw new Error('digest do ZIP executado diverge da evidência E2E');
  }
  const evidenceAssetPath = path.join(
    securityDir,
    'real-mission-evidence.json',
  );
  if (path.resolve(options.evidencePath) !== evidenceAssetPath) {
    fs.copyFileSync(options.evidencePath, evidenceAssetPath);
  }
  const e2eEvidence = hashFile(evidenceAssetPath);
  const claudeEvidenceAssetPath = path.join(
    securityDir,
    'real-mission-evidence-claude-orchestrator.json',
  );
  const isClaudeSkipped = hasExactClaudeOrchestratorSkip(
    options.skippedOrchestrators,
  );
  if (
    options.skippedOrchestrators !== undefined &&
    !isClaudeSkipped
  ) {
    throw new Error('invalid skipped release orchestrator declaration');
  }
  let claudeOrchestratorEvidence;
  if (isClaudeSkipped) {
    if (
      options.claudeOrchestratorEvidencePath !== undefined ||
      options.claudeOrchestratorRuntimeProof !== undefined ||
      fs.existsSync(claudeEvidenceAssetPath)
    ) {
      throw new Error(
        'explicit Claude orchestrator skip cannot reuse or fabricate Claude evidence',
      );
    }
  } else {
    // The Claude-orchestrator variant evidence is bound to the same commit,
    // version, identity and ZIP, and carries its own live runtime proof.
    // A fast lane never reuses it: that variant's live runtime proof is
    // unreproducible from a receipt, so a waived cycle must decline the lane
    // instead of pretending the second orchestrator was exercised.
    if (waiver) {
      throw new Error(
        'fast lane requires a baseline with the explicit Claude orchestrator skip',
      );
    }
    if (
      typeof options.claudeOrchestratorEvidencePath !== 'string' ||
      options.claudeOrchestratorRuntimeProof === undefined
    ) {
      throw new Error(
        'claude orchestrator evidence and runtime proof are required',
      );
    }
    const claudeEvidence = assertRealMissionReleaseEvidence(
      parseJson(
        fs.readFileSync(options.claudeOrchestratorEvidencePath, 'utf8'),
        'evidência E2E orquestrador Claude',
      ),
    );
    if (
      claudeEvidence?.status !== 'pass' ||
      claudeEvidence?.launchSurface !== 'product-wizard' ||
      claudeEvidence?.wizardCoverage !== 'main-owned-product-sequence' ||
      claudeEvidence?.release?.commitSha !== commitSha ||
      claudeEvidence?.release?.appVersion !== options.version ||
      claudeEvidence?.release?.artifact?.identity !==
        options.expectedSigningIdentity ||
      claudeEvidence?.release?.artifact?.sha256 !== zip.sha256
    ) {
      throw new Error(
        'evidência E2E orquestrador Claude não pertence ao mesmo commit/versão/identidade/ZIP',
      );
    }
    assertVerifiedRealMissionRuntimeProof(
      options.claudeOrchestratorRuntimeProof,
      {
        evidence: claudeEvidence,
        releaseBinding: {
          appVersion: options.version,
          commitSha,
          artifact: {
            sha256: options.expectedE2EArtifactSha256,
            identity: options.expectedSigningIdentity,
          },
        },
      },
    );
    if (
      path.resolve(options.claudeOrchestratorEvidencePath) !==
      claudeEvidenceAssetPath
    ) {
      fs.copyFileSync(
        options.claudeOrchestratorEvidencePath,
        claudeEvidenceAssetPath,
      );
    }
    claudeOrchestratorEvidence = {
      name: path.basename(claudeEvidenceAssetPath),
      ...hashFile(claudeEvidenceAssetPath),
    };
  }
  const finalizedFields = buildFinalizedReleaseSecurityFields({
    signingIdentity: evidence.release.artifact.identity,
    dmg: { name: path.basename(options.dmgPath), ...dmg },
    zip: { name: path.basename(options.zipPath), ...zip },
    e2eEvidence: {
      name: path.basename(evidenceAssetPath),
      ...e2eEvidence,
    },
    ...(isClaudeSkipped
      ? { skippedOrchestrators: ['claude'] }
      : {
          e2eEvidenceClaudeOrchestrator:
            claudeOrchestratorEvidence,
        }),
    ...(waiver
      ? { fastLaneWaiver: waiver, fastLaneWaiverAsset: FAST_LANE_WAIVER_ASSET }
      : {}),
  });
  const finalized = {
    ...manifest,
    finalizedAt: (options.now ?? (() => new Date()))().toISOString(),
    ...finalizedFields,
  };
  writeJson(manifestPath, finalized);
  return finalized;
}

function parseArgs(argv) {
  let outDir;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--out-dir') {
      outDir = argv[index + 1];
      index += 1;
      continue;
    }
    throw new Error(`argumento desconhecido: ${arg}`);
  }
  return { outDir };
}

async function main() {
  const { outDir } = parseArgs(process.argv.slice(2));
  const root = process.cwd();
  const authority = readAndAssertReleaseAuthority(root);
  const repository = collectReleaseRepositoryState({
    version: authority.version,
    allowedTagSignerFingerprints:
      authority.allowedTagSignerFingerprints,
    gitCapture: (args) => {
      const result = spawnSync('git', args, {
        cwd: root,
        env: process.env,
        encoding: 'utf8',
        shell: false,
      });
      if (result.error) throw result.error;
      if (result.status !== 0) {
        throw new Error(`git ${args[0]} failed`);
      }
      return result;
    },
  });
  const state = assertReleaseRepositoryState({
    ...repository,
    version: authority.version,
    allowedTagSignerFingerprints:
      authority.allowedTagSignerFingerprints,
    allowedUntrackedPrefixes: ['release-artifacts'],
  });
  const result = buildReleaseSecurityArtifactsWithPinnedNpm({
    root,
    outDir,
    commitSha: state.commitSha,
    tagObjectSha: state.tagObjectSha,
    tagSignerFingerprint: state.tagSignerFingerprint,
    tagSignatureVerified: state.tagSignatureVerified,
    npmVersion: authority.npmVersion,
    npmPackageIntegrity: authority.npmPackageIntegrity,
    expectedNodeVersion: authority.nodeVersion,
  });
  assertReleaseSecurityManifest({
    root,
    securityDir: result.outDir,
    manifest: result.manifest,
    commitSha: state.commitSha,
    version: authority.version,
    tagObjectSha: state.tagObjectSha,
    tagSignerFingerprint: state.tagSignerFingerprint,
    tagSignatureVerified: state.tagSignatureVerified,
  });
  process.stdout.write(
    `[release-security] PASS: audit prod/toolchain=0; SBOM/checksums em ${result.outDir}\n`,
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  main().catch((error) => {
    process.stderr.write(
      `[release-security] FAIL: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
