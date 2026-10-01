import claudeRaw from './claude.json';
import codexRaw from './codex.json';
import kimiRaw from './kimi.json';
import grokRaw from './grok.json';
import glmRaw from './glm.json';
import glmFlashRaw from './glm-flash.json';
import longcatRaw from './longcat.json';
import aiderRaw from './aider.json';
import agyRaw from './agy.json';
import opencodeRaw from './opencode.json';
import mimoCodeRaw from './mimo-code.json';
import minimaxCodeRaw from './minimax-code.json';
import openclaudeRaw from './openclaude.json';
import museRaw from './muse.json';
import museClaudeRaw from './muse-claude.json';
import devinRaw from './devin.json';
import deepseekRaw from './deepseek.json';
import qwenRaw from './qwen.json';

/** All builtin adapter definitions, bundled at compile time. */
export const BUILTIN_ADAPTERS: unknown[] = [
  claudeRaw,
  codexRaw,
  kimiRaw,
  grokRaw,
  glmRaw,
  glmFlashRaw,
  longcatRaw,
  aiderRaw,
  agyRaw,
  opencodeRaw,
  mimoCodeRaw,
  // minimax-code: CLI nativa `mcode` (@minimax-ai/code). Worker PTY sem MCP
  // do Nexus — a TUI só lê MCP do config.yaml do data dir ou do `.mcp.json`
  // do checkout; o caminho com MCP é o harness ACP (`mcode acp`).
  minimaxCodeRaw,
  openclaudeRaw,
  museRaw,
  // Opcional: Muse Spark dentro do Claude Code (ANTHROPIC_BASE_URL Meta).
  // O default continua `muse` — CLI própria. Este adapter é a rota GLM-like.
  museClaudeRaw,
  // devin: `extraArgs` fica vazio de propósito. O `--respect-workspace-trust
  // false` só existe no headless (print mode não sabe mostrar o prompt e falha
  // em diretório não confiado — está no próprio --help da CLI), e o headless
  // daqui alimenta só o executor de benchmark (cli-benchmark-executor), que não
  // aplica control args: ali o modo é o default da CLI (`auto`, que aprova
  // leitura e ainda pede aprovação para edição). No interativo o trust
  // ("Do you trust the authors of this directory?") é aceito pelo
  // cliPromptAutoResponder, e o brief da missão entra por colagem depois do
  // composer ("Ask Devin to build") — o mesmo canal do Kimi. Argv posicional
  // (`-- <PROMPT>`) nascia antes do trust e o pane ficava mudo.
  //
  // Permissão: como TODOS os outros builtins, o adapter declara
  // `control.permission.yolo` ("--permission-mode dangerous"). buildControlArgs
  // (control-args.ts:33) aplica esse argv quando nenhum modo foi escolhido, ou
  // seja: spawn sem escolha explícita roda full-auto, igual a claude/glm/codex.
  // Quem quiser aprovação por edição escolhe outro modo no settings do provider.
  devinRaw,
  deepseekRaw,
  qwenRaw,
];
