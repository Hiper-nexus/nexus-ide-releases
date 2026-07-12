/**
 * Shared aspect-ratio helpers for image providers.
 * Gemini honors ratios natively; OpenAI gpt-image maps to nearest size.
 */

const GEMINI_ASPECTS = new Set([
  '1:1',
  '16:9',
  '9:16',
  '4:3',
  '3:4',
  '3:2',
  '2:3',
]);

/** Normalize and validate a Gemini imageConfig.aspectRatio value. */
export function geminiImageAspect(raw: string | undefined): string | undefined {
  if (!raw?.trim()) return undefined;
  const value = raw.trim().replace(/\s+/g, '');
  if (!GEMINI_ASPECTS.has(value)) {
    throw new Error(
      `aspectRatio inválido para Gemini: ${raw} ` +
        `(use ${[...GEMINI_ASPECTS].join(', ')})`,
    );
  }
  return value;
}

/**
 * Map a logical aspect ratio to an OpenAI Images size.
 * gpt-image rejects arbitrary ratios — only three sizes are accepted.
 */
export function openaiImageSize(raw: string | undefined): string | undefined {
  if (!raw?.trim()) return undefined;
  const value = raw.trim().replace(/\s+/g, '');
  if (value === '1:1' || value === '1024x1024') return '1024x1024';
  if (value === '16:9' || value === '3:2' || value === '1536x1024') {
    return '1536x1024';
  }
  if (value === '9:16' || value === '2:3' || value === '1024x1536') {
    return '1024x1536';
  }
  if (value === '4:3' || value === '3:4') {
    // Nearest landscape/portrait openai sizes.
    return value === '4:3' ? '1536x1024' : '1024x1536';
  }
  throw new Error(
    `aspectRatio inválido para OpenAI image: ${raw} ` +
      '(use 1:1, 16:9, 9:16, 4:3, 3:4)',
  );
}
