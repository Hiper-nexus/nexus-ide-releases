import claudeRaw from './claude.json';
import codexRaw from './codex.json';
import kimiRaw from './kimi.json';
import grokRaw from './grok.json';
import glmRaw from './glm.json';
import longcatRaw from './longcat.json';
import aiderRaw from './aider.json';
import agyRaw from './agy.json';
import opencodeRaw from './opencode.json';
import ompRaw from './omp.json';

/** All builtin adapter definitions, bundled at compile time. */
export const BUILTIN_ADAPTERS: unknown[] = [
  claudeRaw,
  codexRaw,
  kimiRaw,
  grokRaw,
  glmRaw,
  longcatRaw,
  aiderRaw,
  agyRaw,
  opencodeRaw,
  ompRaw,
];
