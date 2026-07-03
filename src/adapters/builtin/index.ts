import claudeRaw from './claude.json';
import codexRaw from './codex.json';
import aiderRaw from './aider.json';
import agyRaw from './agy.json';
import opencodeRaw from './opencode.json';

/** All builtin adapter definitions, bundled at compile time. */
export const BUILTIN_ADAPTERS: unknown[] = [
  claudeRaw,
  codexRaw,
  aiderRaw,
  agyRaw,
  opencodeRaw,
];
