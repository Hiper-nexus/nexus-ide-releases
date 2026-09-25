import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Runtime half of skill-manifest-offload. The bundle replaces a generated
 * skill manifest with a call to this function: small assets arrive inline,
 * large ones stay in a JSON payload next to the Main chunks and are read,
 * verified against their build-time sha256 and released again only when a
 * delivery actually has to write them.
 */

export interface OffloadedAssetMeta {
  readonly encoding: 'utf8' | 'base64';
  readonly executable?: boolean;
  /** sha256 of the decoded bytes, computed at build time. */
  readonly sha256: string;
  /** Decoded byte length. */
  readonly size: number;
}

export interface InlineAssetMeta extends OffloadedAssetMeta {
  readonly content: string;
}

export interface OffloadedSkillAsset extends OffloadedAssetMeta {
  readonly content: string;
}

export function offloadedSkillManifest(
  payloadFile: string,
  inline: Readonly<Record<string, InlineAssetMeta>>,
  offloaded: Readonly<Record<string, OffloadedAssetMeta>>,
): Record<string, OffloadedSkillAsset> {
  let payload: Record<string, unknown> | null = null;
  const verified = new Set<string>();

  const contentOf = (relPath: string, meta: OffloadedAssetMeta): string => {
    if (payload === null) {
      payload = JSON.parse(fs.readFileSync(payloadFile, 'utf8')) as Record<string, unknown>;
      // Kept only for the synchronous delivery that needed it: the payload is
      // megabytes, and holding it is exactly what this module avoids.
      setImmediate(() => {
        payload = null;
        verified.clear();
      });
    }
    const content = payload[relPath];
    if (typeof content !== 'string') {
      throw new Error(
        `bundled skill asset missing from ${path.basename(payloadFile)}: ${relPath}`,
      );
    }
    if (!verified.has(relPath)) {
      const digest = createHash('sha256')
        .update(Buffer.from(content, meta.encoding))
        .digest('hex');
      if (digest !== meta.sha256) {
        throw new Error(`bundled skill asset failed verification: ${relPath}`);
      }
      verified.add(relPath);
    }
    return content;
  };

  const manifest: Record<string, OffloadedSkillAsset> = {};
  for (const [relPath, asset] of Object.entries(inline)) {
    manifest[relPath] = Object.freeze({ ...asset });
  }
  for (const [relPath, meta] of Object.entries(offloaded)) {
    manifest[relPath] = Object.freeze({
      encoding: meta.encoding,
      ...(meta.executable ? { executable: true } : {}),
      sha256: meta.sha256,
      size: meta.size,
      get content(): string {
        return contentOf(relPath, meta);
      },
    });
  }
  return Object.freeze(manifest);
}
