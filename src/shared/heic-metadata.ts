// Adapted from pingdotgg/t3code @ 26285ab80513260d1ff29d2c3fbe18f21990cb62
// Copyright (c) 2026 T3 Tools Inc. — MIT License
// See third_party/licenses/t3code-MIT.txt. Nexus changes: o parser de
// metadados HEIC (meta/iprp/ipco/ispe) de imageCompression.ts saiu para
// src/shared e recebe um DataView já limitado, para o renderer e o main
// aplicarem o mesmo teto de pixels antes de qualquer decodificação.

export const MAX_HEIC_DECODE_PIXELS = 64_000_000;
export const MAX_HEIC_METADATA_BYTES = 1024 * 1024;

export type HeicDimensionsError = 'too-large' | 'unreadable';

interface HeicMetadataBox {
  payloadOffset: number;
  endOffset: number;
}

function findHeicMetadataBox(
  view: DataView,
  startOffset: number,
  endOffset: number,
  type: number,
): HeicMetadataBox | null {
  let offset = startOffset;
  while (offset + 8 <= endOffset) {
    let size = view.getUint32(offset);
    let headerSize = 8;
    if (size === 1) {
      if (offset + 16 > endOffset) return null;
      const extendedSize = view.getBigUint64(offset + 8);
      if (extendedSize > BigInt(Number.MAX_SAFE_INTEGER)) return null;
      size = Number(extendedSize);
      headerSize = 16;
    } else if (size === 0) {
      size = endOffset - offset;
    }
    if (size < headerSize || size > endOffset - offset) return null;

    const nextOffset = offset + size;
    if (view.getUint32(offset + 4) === type) {
      return { payloadOffset: offset + headerSize, endOffset: nextOffset };
    }
    offset = nextOffset;
  }
  return null;
}

/**
 * Read HEIC image dimensions before the decoder allocates full RGBA buffers.
 * `view` must already be capped (callers slice at most
 * `MAX_HEIC_METADATA_BYTES`), so a hostile file never costs a full read.
 */
export function heicDimensionsError(view: DataView): HeicDimensionsError | null {
  const meta = findHeicMetadataBox(view, 0, view.byteLength, 0x6d657461);
  if (!meta || meta.payloadOffset + 4 > meta.endOffset) return 'unreadable';
  const properties = findHeicMetadataBox(
    view,
    meta.payloadOffset + 4,
    meta.endOffset,
    0x69707270,
  );
  if (!properties) return 'unreadable';
  const containers = findHeicMetadataBox(
    view,
    properties.payloadOffset,
    properties.endOffset,
    0x6970636f,
  );
  if (!containers) return 'unreadable';

  let offset = containers.payloadOffset;
  let foundImageDimensions = false;
  while (offset < containers.endOffset) {
    const image = findHeicMetadataBox(view, offset, containers.endOffset, 0x69737065);
    if (!image) break;
    if (image.payloadOffset + 12 > image.endOffset) return 'unreadable';
    const width = view.getUint32(image.payloadOffset + 4);
    const height = view.getUint32(image.payloadOffset + 8);
    if (width === 0 || height === 0) return 'unreadable';
    if (width > MAX_HEIC_DECODE_PIXELS / height) return 'too-large';
    foundImageDimensions = true;
    offset = image.endOffset;
  }
  return foundImageDimensions ? null : 'unreadable';
}
