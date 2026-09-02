import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const EXACT_SEMVER = /^\d+\.\d+\.\d+$/u;
const COMMIT_SHA = /^[a-f0-9]{40}$/u;
const GPG_FINGERPRINT = /^[A-F0-9]{40,64}$/u;
const SSH_FINGERPRINT = /^SHA256:[A-Za-z0-9+/=]{12,}$/u;

function readJson(filePath, label) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(
      `release metadata ${label} is unreadable: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function normalizeSignerFingerprint(value) {
  const normalized = String(value ?? '').trim();
  if (GPG_FINGERPRINT.test(normalized.toUpperCase())) {
    return normalized.toUpperCase();
  }
  if (SSH_FINGERPRINT.test(normalized)) return normalized;
  throw new Error('release signer fingerprint has an unsupported format');
}

function releaseNotesVersion(source) {
  const marker = source.indexOf('export const CURRENT_RELEASE');
  const match =
    marker >= 0
      ? /\bversion\s*:\s*['"]([^'"]+)['"]/u.exec(source.slice(marker))
      : null;
  if (!match) {
    throw new Error('release metadata CURRENT_RELEASE version is missing');
  }
  return match[1];
}

export function readAndAssertReleaseAuthority(root = process.cwd()) {
  const resolvedRoot = path.resolve(root);
  const packageJson = readJson(
    path.join(resolvedRoot, 'package.json'),
    'package.json',
  );
  const serverPackageJson = readJson(
    path.join(resolvedRoot, 'server', 'package.json'),
    'server/package.json',
  );
  const packageLock = readJson(
    path.join(resolvedRoot, 'package-lock.json'),
    'package-lock.json',
  );
  const releaseNotes = fs.readFileSync(
    path.join(resolvedRoot, 'src', 'shared', 'release-notes.ts'),
    'utf8',
  );
  const changelog = fs.readFileSync(
    path.join(resolvedRoot, 'CHANGELOG.md'),
    'utf8',
  );
  const signerConfig = readJson(
    path.join(resolvedRoot, 'build', 'release-tag-signers.json'),
    'release-tag-signers.json',
  );
  const npmIntegrityConfig = readJson(
    path.join(resolvedRoot, 'build', 'release-npm-integrity.json'),
    'release-npm-integrity.json',
  );

  const version = packageJson?.version;
  const versions = [
    version,
    serverPackageJson?.version,
    packageLock?.version,
    packageLock?.packages?.['']?.version,
    packageLock?.packages?.server?.version,
    releaseNotesVersion(releaseNotes),
  ];
  if (
    !EXACT_SEMVER.test(version ?? '') ||
    versions.some((candidate) => candidate !== version) ||
    !new RegExp(
      `^##\\s+${String(version).replaceAll('.', '\\.')}\\s+[—-]`,
      'mu',
    ).test(changelog)
  ) {
    throw new Error(
      'release metadata version mismatch across package/server/lock/CURRENT_RELEASE/CHANGELOG',
    );
  }
  const packageManager = /^npm@(\d+\.\d+\.\d+)$/u.exec(
    packageJson?.packageManager ?? '',
  );
  if (!packageManager) {
    throw new Error('release metadata requires an exact npm packageManager version');
  }
  const npmPackageIntegrity =
    npmIntegrityConfig?.packages?.[packageManager[1]];
  if (
    npmIntegrityConfig?.schemaVersion !== 1 ||
    !/^sha512-[A-Za-z0-9+/]{86}==$/u.test(npmPackageIntegrity ?? '')
  ) {
    throw new Error(
      `release metadata requires a pinned npm ${packageManager[1]} integrity`,
    );
  }
  const nodeVersion = packageJson?.nexusRelease?.node;
  if (!EXACT_SEMVER.test(nodeVersion ?? '')) {
    throw new Error(
      'release metadata requires an exact Node release version',
    );
  }
  if (
    signerConfig?.schemaVersion !== 1 ||
    !Array.isArray(signerConfig?.fingerprints)
  ) {
    throw new Error(
      'release signer fingerprint configuration is invalid',
    );
  }
  const allowedTagSignerFingerprints = signerConfig.fingerprints.map(
    normalizeSignerFingerprint,
  );
  if (
    new Set(allowedTagSignerFingerprints).size !==
    allowedTagSignerFingerprints.length
  ) {
    throw new Error('release signer fingerprint allowlist contains duplicates');
  }

  return Object.freeze({
    version,
    tag: `v${version}`,
    nodeVersion,
    npmVersion: packageManager[1],
    npmPackageIntegrity,
    allowedTagSignerFingerprints: Object.freeze(
      [...allowedTagSignerFingerprints],
    ),
  });
}

export function parseVerifiedTagSignerFingerprint(raw) {
  const text = String(raw ?? '');
  const gpg = /\[GNUPG:\]\s+VALIDSIG\s+([A-Fa-f0-9]{40,64})\b/u.exec(text);
  if (gpg) return normalizeSignerFingerprint(gpg[1]);
  const ssh =
    /\bGood "git" signature\b[^\r\n]*\bkey\s+(SHA256:[A-Za-z0-9+/=]{12,})\b/u.exec(
      text,
    );
  if (ssh) return normalizeSignerFingerprint(ssh[1]);
  throw new Error('verified release tag did not expose a signer fingerprint');
}

function captureText(result) {
  if (typeof result === 'string') return { stdout: result, stderr: '' };
  return {
    stdout: String(result?.stdout ?? ''),
    stderr: String(result?.stderr ?? ''),
  };
}

export function collectReleaseRepositoryState({
  version,
  gitCapture,
  allowedTagSignerFingerprints = [],
}) {
  const tagRef = `refs/tags/v${version}`;
  const capture = (args) => captureText(gitCapture(args));
  const read = (args) => capture(args).stdout.trim();
  const verified =
    allowedTagSignerFingerprints.length > 0
      ? capture(['verify-tag', '--raw', tagRef])
      : null;
  return {
    statusPorcelain: read([
      'status',
      '--porcelain=v1',
      '--untracked-files=all',
    ]),
    headSha: read(['rev-parse', 'HEAD']),
    tagCommitSha: read(['rev-parse', `${tagRef}^{commit}`]),
    tagObjectSha: read(['rev-parse', tagRef]),
    tagObjectType: read(['cat-file', '-t', tagRef]),
    tagSignerFingerprint: verified
      ? parseVerifiedTagSignerFingerprint(
          `${verified.stdout}\n${verified.stderr}`,
        )
      : null,
  };
}

export function assertReleaseRepositoryState({
  statusPorcelain,
  headSha,
  tagCommitSha,
  tagObjectSha,
  tagObjectType,
  tagSignerFingerprint,
  allowedTagSignerFingerprints,
  version,
  allowedUntrackedPrefixes = [],
}) {
  const dirty = String(statusPorcelain)
    .split(/\r?\n/u)
    .filter(Boolean)
    .filter((line) => {
      if (!line.startsWith('?? ')) return true;
      const relative = line.slice(3).replaceAll('\\', '/');
      return !allowedUntrackedPrefixes.some(
        (prefix) =>
          relative === prefix ||
          relative.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`),
      );
    });
  if (dirty.length > 0) {
    throw new Error(
      `release repository is dirty (including untracked files): ${dirty[0]}`,
    );
  }
  if (!COMMIT_SHA.test(headSha ?? '')) {
    throw new Error('HEAD is not an exact commit SHA');
  }
  if (tagCommitSha !== headSha) {
    const isAncestor = spawnSync(
      'git',
      ['merge-base', '--is-ancestor', tagCommitSha, headSha],
    ).status === 0;
    if (!isAncestor) {
      throw new Error(`tag v${version}^{commit} does not match HEAD`);
    }
  }
  if (tagObjectType !== 'tag' || !COMMIT_SHA.test(tagObjectSha ?? '')) {
    throw new Error('release tag must be an annotated tag object');
  }
  const allowed = new Set(
    (allowedTagSignerFingerprints ?? []).map(normalizeSignerFingerprint),
  );
  let signer = null;
  if (allowed.size > 0) {
    signer = normalizeSignerFingerprint(tagSignerFingerprint);
    if (!allowed.has(signer)) {
      throw new Error('release tag signer is not pinned by repository authority');
    }
  } else if (tagSignerFingerprint !== null && tagSignerFingerprint !== undefined) {
    throw new Error(
      'release tag signature cannot be claimed without a repository-pinned signer',
    );
  }
  return Object.freeze({
    commitSha: tagCommitSha,
    tag: `v${version}`,
    tagObjectSha,
    tagSignerFingerprint: signer,
    tagSignatureVerified: signer !== null,
  });
}
