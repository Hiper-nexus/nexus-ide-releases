import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_SNAPSHOT_MODE = 0o400;
const COPY_BUFFER_BYTES = 1024 * 1024;

function currentUid() {
  if (typeof process.getuid !== "function") {
    throw new Error("private artifact snapshots require POSIX uid authority");
  }
  return BigInt(process.getuid());
}

function assertRegularOwnedFile(
  stat,
  label,
  { expectedMode = null, expectedLinkCount = 1n } = {},
) {
  const mode = Number(stat.mode & 0o777n);
  if (
    !stat.isFile() ||
    stat.nlink !== expectedLinkCount ||
    stat.uid !== currentUid() ||
    (expectedMode === null ? (mode & 0o022) !== 0 : mode !== expectedMode)
  ) {
    throw new Error(
      `${label} must be a regular, single-link, current-uid file with safe mode`,
    );
  }
}

function hashOpenFile(fd, bytes) {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES);
  let offset = 0;
  while (offset < bytes) {
    const length = Math.min(buffer.byteLength, bytes - offset);
    const read = fs.readSync(fd, buffer, 0, length, offset);
    if (read <= 0) throw new Error("private artifact snapshot ended early");
    hash.update(buffer.subarray(0, read));
    offset += read;
  }
  return hash.digest("hex");
}

function fsyncDirectory(directory) {
  const directoryFd = fs.openSync(
    directory,
    fs.constants.O_RDONLY | fs.constants.O_DIRECTORY,
  );
  try {
    fs.fsyncSync(directoryFd);
  } finally {
    fs.closeSync(directoryFd);
  }
}

export function openPrivateArtifactSnapshot(
  sourcePath,
  { prefix = "nexus-artifact-snapshot-" } = {},
) {
  const resolvedSource = path.resolve(sourcePath);
  const sourceFd = fs.openSync(
    resolvedSource,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
  );
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.chmodSync(temporaryRoot, PRIVATE_DIRECTORY_MODE);
  const snapshotPath = path.join(temporaryRoot, "candidate.snapshot");
  let snapshotFd = null;
  try {
    const sourceStat = fs.fstatSync(sourceFd, { bigint: true });
    assertRegularOwnedFile(sourceStat, "candidate artifact");
    if (sourceStat.size <= 0n || sourceStat.size > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error("candidate artifact size is invalid");
    }
    const writerFd = fs.openSync(
      snapshotPath,
      fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        fs.constants.O_WRONLY |
        fs.constants.O_NOFOLLOW,
      0o600,
    );
    try {
      const buffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES);
      let offset = 0;
      const bytes = Number(sourceStat.size);
      while (offset < bytes) {
        const length = Math.min(buffer.byteLength, bytes - offset);
        const read = fs.readSync(sourceFd, buffer, 0, length, offset);
        if (read <= 0) {
          throw new Error("candidate artifact changed during snapshot");
        }
        let written = 0;
        while (written < read) {
          written += fs.writeSync(
            writerFd,
            buffer,
            written,
            read - written,
            offset + written,
          );
        }
        offset += read;
      }
      fs.fsyncSync(writerFd);
    } finally {
      fs.closeSync(writerFd);
    }
    const sourceAfter = fs.fstatSync(sourceFd, { bigint: true });
    if (
      sourceAfter.dev !== sourceStat.dev ||
      sourceAfter.ino !== sourceStat.ino ||
      sourceAfter.size !== sourceStat.size ||
      sourceAfter.mtimeNs !== sourceStat.mtimeNs ||
      sourceAfter.ctimeNs !== sourceStat.ctimeNs
    ) {
      throw new Error("candidate artifact changed during snapshot");
    }
    fs.chmodSync(snapshotPath, PRIVATE_SNAPSHOT_MODE);
    fsyncDirectory(temporaryRoot);
    snapshotFd = fs.openSync(
      snapshotPath,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
    );
    const snapshotStat = fs.fstatSync(snapshotFd, { bigint: true });
    assertRegularOwnedFile(
      snapshotStat,
      "private artifact snapshot",
      { expectedMode: PRIVATE_SNAPSHOT_MODE },
    );
    if (snapshotStat.size !== sourceStat.size) {
      throw new Error("private artifact snapshot size mismatch");
    }
    const bytes = Number(snapshotStat.size);
    const sha256 = hashOpenFile(snapshotFd, bytes);
    fs.unlinkSync(snapshotPath);
    fsyncDirectory(temporaryRoot);
    const anonymousStat = fs.fstatSync(snapshotFd, { bigint: true });
    assertRegularOwnedFile(
      anonymousStat,
      "anonymous private artifact snapshot",
      {
        expectedMode: PRIVATE_SNAPSHOT_MODE,
        expectedLinkCount: 0n,
      },
    );
    const authority = Object.freeze({
      temporaryRoot,
      fd: snapshotFd,
      bytes,
      sha256,
      device: snapshotStat.dev.toString(),
      inode: snapshotStat.ino.toString(),
    });
    snapshotFd = null;
    return authority;
  } catch (error) {
    if (snapshotFd !== null) fs.closeSync(snapshotFd);
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
    throw error;
  } finally {
    fs.closeSync(sourceFd);
  }
}

export function verifyPrivateArtifactSnapshot(authority) {
  const stat = fs.fstatSync(authority.fd, { bigint: true });
  assertRegularOwnedFile(
    stat,
    "anonymous private artifact snapshot",
    {
      expectedMode: PRIVATE_SNAPSHOT_MODE,
      expectedLinkCount: 0n,
    },
  );
  if (
    stat.dev.toString() !== authority.device ||
    stat.ino.toString() !== authority.inode ||
    Number(stat.size) !== authority.bytes ||
    hashOpenFile(authority.fd, authority.bytes) !== authority.sha256
  ) {
    throw new Error("private artifact snapshot authority changed");
  }
  return authority;
}

export function closePrivateArtifactSnapshot(authority) {
  try {
    fs.closeSync(authority.fd);
  } finally {
    fs.rmSync(authority.temporaryRoot, { recursive: true, force: true });
  }
}
