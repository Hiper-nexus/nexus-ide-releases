import claudeRaw from './claude.json';
import codexRaw from './codex.json';
import geminiRaw from './gemini.json';
import kimiRaw from './kimi.json';
import grokRaw from './grok.json';
import glmRaw from './glm.json';
import aiderRaw from './aider.json';
import agyRaw from './agy.json';
import opencodeRaw from './opencode.json';

/** All builtin adapter definitions, bundled at compile time. */
export const BUILTIN_ADAPTERS: unknown[] = [
  claudeRaw,
  codexRaw,
  geminiRaw,
  kimiRaw,
  grokRaw,
  glmRaw,
  aiderRaw,
  agyRaw,
  opencodeRaw,
];
