const MODEL_KEY_ERROR_RE =
  /nenhuma key de modelo|GEMINI_API_KEY|OPENAI_API_KEY|GROQ_API_KEY/i;

export function isMissingModelKeyError(error: string | null | undefined): boolean {
  return MODEL_KEY_ERROR_RE.test(error ?? '');
}
