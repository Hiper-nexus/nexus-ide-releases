import { assertMcpInvocationCurrent, type McpToolDef } from './mcp-protocol';
import { findMediaProvider } from '../media/media-providers';
import { resolveMediaKey } from '../media/media-keys';
import { readMediaInput } from '../media/media-path-policy';
import { listElevenLabsVoices } from '../media/elevenlabs-voices';
import { generateVoiceover, VOICEOVER_MAX_CHARS } from '../media/voiceover';
import { isNexusClonedVoice } from '../media/voice-origin';
import { recordMediaUsage } from '../usage/media-usage-recorder';
import { num, str } from './tool-util';
import { resolveCwdForScope } from './workspace-path';
import { executionScopeFor, type AgentGateContext } from './gate';

/**
 * Voice tools for presentation videos (F-1591). The agent can LIST the voices
 * of the user's ElevenLabs account and NARRATE a script with one of them. No
 * tool here, or anywhere in the MCP registry, creates or clones a voice:
 * cloning is a human-only flow in Ajustes → Serviços de mídia → Minha voz.
 */

const SCRIPT_FILE_MAX_BYTES = 200 * 1024;
const SCRIPT_EXTENSIONS = /\.(?:txt|md)$/iu;

function baseDirFor(ctx: AgentGateContext): string {
  return resolveCwdForScope(executionScopeFor(ctx));
}

function readScript(args: Record<string, unknown>, baseDir: string): string {
  const inline = str(args, 'script');
  const file = str(args, 'scriptPath');
  if (inline && file) throw new Error('use script OU scriptPath, não os dois');
  if (inline) return inline;
  if (!file) throw new Error('missing required argument: script (ou scriptPath)');
  if (!SCRIPT_EXTENSIONS.test(file)) throw new Error('scriptPath precisa ser .txt ou .md');
  const input = readMediaInput(file, baseDir);
  if (input.data.length > SCRIPT_FILE_MAX_BYTES) {
    throw new Error('roteiro grande demais (máx. 200 KB)');
  }
  return input.data.toString('utf8');
}

function voiceSettingsFrom(args: Record<string, unknown>) {
  const raw = args.voiceSettings;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  return {
    stability: num(record, 'stability'),
    similarityBoost: num(record, 'similarityBoost'),
    style: num(record, 'style'),
    speed: num(record, 'speed'),
  };
}

const voiceListTool: McpToolDef = {
  name: 'nexus_voice_list',
  description:
    'List the voices of the ElevenLabs account configured in the Nexus. Each ' +
    'voice has an origin: library (premade or shared), designed, nexus-clone ' +
    '(the operator cloned it in Minha voz, with a consent receipt) or ' +
    'external-clone. Narrate ONLY with the voice the operator indicated; ' +
    'never assume a clone is the operator. There is no tool to clone voices.',
  inputSchema: { type: 'object', properties: {} },
  handler: async (_args, _ctx, invocation) => {
    assertMcpInvocationCurrent(invocation);
    const def = findMediaProvider('elevenlabs');
    const key = def ? resolveMediaKey(def) : undefined;
    if (!key) {
      return {
        ok: false,
        error: 'ElevenLabs sem chave — configure em Ajustes → Serviços de mídia',
      };
    }
    const voices = await listElevenLabsVoices({
      key,
      fetchFn: fetch,
      isNexusClone: isNexusClonedVoice,
      signal: invocation?.signal,
    });
    assertMcpInvocationCurrent(invocation);
    return { ok: true, voices };
  },
};

const voiceoverGenerateTool: McpToolDef = {
  name: 'nexus_voiceover_generate',
  description:
    'Narrate a video script with an ElevenLabs voice and write, inside the ' +
    'workspace: <outDir>/<baseName>.mp3, .timeline.json (every word, sentence ' +
    'and paragraph with startMs/endMs), .srt and .vtt (captions with the ' +
    "script's spelling). Time every scene and caption from the timeline JSON; " +
    'never hand-write timings. Call with dryRun:true first to see characters ' +
    'and cost (USD) without paying. Repeating the same text costs nothing ' +
    `(chunk cache); editing one paragraph pays only that paragraph. Max ` +
    `${VOICEOVER_MAX_CHARS} characters. voiceId comes from nexus_voice_list ` +
    'and must be the voice the operator asked for. Missing key → STOP and ' +
    'report "configure ElevenLabs em Ajustes → Serviços de mídia".',
  inputSchema: {
    type: 'object',
    properties: {
      script: { type: 'string', description: 'Narration text. Blank lines separate paragraphs.' },
      scriptPath: { type: 'string', description: 'Workspace .txt/.md with the script (instead of script).' },
      voiceId: { type: 'string' },
      model: { type: 'string', description: 'ElevenLabs model id (default from nexus_media_providers).' },
      outDir: { type: 'string', description: 'Workspace folder for the files (default "narration").' },
      baseName: { type: 'string', description: 'File stem (default "narration").' },
      languageCode: { type: 'string', description: 'ISO 639-1, e.g. "pt" (not for multilingual v2).' },
      voiceSettings: {
        type: 'object',
        properties: {
          stability: { type: 'number' },
          similarityBoost: { type: 'number' },
          style: { type: 'number' },
          speed: { type: 'number' },
        },
      },
      dryRun: { type: 'boolean' },
    },
    required: [],
  },
  requiresConfirm: true,
  handler: async (args, ctx, invocation) => {
    assertMcpInvocationCurrent(invocation);
    const baseDir = baseDirFor(ctx);
    const result = await generateVoiceover({
      script: readScript(args, baseDir),
      voiceId: str(args, 'voiceId'),
      model: str(args, 'model'),
      outDir: str(args, 'outDir'),
      baseName: str(args, 'baseName'),
      languageCode: str(args, 'languageCode'),
      voiceSettings: voiceSettingsFrom(args),
      dryRun: args.dryRun === true,
      baseDir,
      signal: invocation?.signal,
      assertCurrentAuthority: invocation?.assertCurrentAuthority,
    });
    assertMcpInvocationCurrent(invocation);
    // Only a paid synthesis is a new generation; a full cache hit is not.
    if (!result.dryRun && result.files && (result.estimatedCostUsd ?? 0) > 0) {
      await recordMediaUsage(
        {
          ok: true,
          path: result.files.audio,
          provider: 'elevenlabs',
          model: result.model,
          kind: 'audio',
          estimatedCostUsd: result.estimatedCostUsd,
          durationMs: result.durationMs ?? 0,
        },
        ctx,
        invocation,
      );
      assertMcpInvocationCurrent(invocation);
    }
    return result;
  },
};

export function buildVoiceTools(): McpToolDef[] {
  return [voiceListTool, voiceoverGenerateTool];
}
