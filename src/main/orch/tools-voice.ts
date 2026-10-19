import { assertMcpInvocationCurrent, type McpToolDef } from './mcp-protocol';
import { isVideoStudioEnabled, VIDEO_STUDIO_DISABLED_REASON } from '../video/video-studio-flag';
import { findMediaProvider } from '../media/media-providers';
import { resolveMediaKey } from '../media/media-keys';
import { readMediaInput } from '../media/media-path-policy';
import { listElevenLabsVoices } from '../media/elevenlabs-voices';
import { generateVoiceover, VOICEOVER_MAX_CHARS } from '../media/voiceover';
import { generateMusic, MUSIC_MAX_MS, MUSIC_MIN_MS, MUSIC_MODELS } from '../media/music-generation';
import { isNexusClonedVoice } from '../media/voice-origin';
import { recordMediaUsage } from '../usage/media-usage-recorder';
import { reserveMediaSpend } from '../media/media-budget';
import { musicCostUsd } from '../media/music-generation';
import { num, str } from './tool-util';
import { resolveCwdForScope } from './workspace-path';
import { executionScopeFor, type AgentGateContext } from './gate';

/**
 * Audio tools for presentation videos. The agent can LIST the voices of the
 * user's ElevenLabs account, NARRATE a script with one of them (F-1591) and
 * compose background MUSIC (F-1592). No tool here, or anywhere in the MCP
 * registry, creates or clones a voice: cloning is a human-only flow in
 * Ajustes → Serviços de mídia → Minha voz.
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
  available: isVideoStudioEnabled,
  unavailableReason: VIDEO_STUDIO_DISABLED_REASON,
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
  available: isVideoStudioEnabled,
  unavailableReason: VIDEO_STUDIO_DISABLED_REASON,
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
    const request = {
      script: readScript(args, baseDir),
      voiceId: str(args, 'voiceId'),
      model: str(args, 'model'),
      outDir: str(args, 'outDir'),
      baseName: str(args, 'baseName'),
      languageCode: str(args, 'languageCode'),
      voiceSettings: voiceSettingsFrom(args),
      baseDir,
      signal: invocation?.signal,
      assertCurrentAuthority: invocation?.assertCurrentAuthority,
    };
    if (args.dryRun === true) return generateVoiceover({ ...request, dryRun: true });
    // F-1606: price what is NOT in the cache, then reserve it under the media cap.
    const priced = await generateVoiceover({ ...request, dryRun: true });
    const spend = reserveMediaSpend({ provider: 'elevenlabs', usd: priced.estimatedCostUsd }, ctx.missionId, 'voiceover_generate');
    if (!spend.ok) return spend;
    let result: Awaited<ReturnType<typeof generateVoiceover>>;
    try {
      result = await generateVoiceover({ ...request, dryRun: false });
    } catch (error) {
      spend.release();
      throw error;
    }
    spend.settle(result.estimatedCostUsd);
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

const musicGenerateTool: McpToolDef = {
  name: 'nexus_music_generate',
  available: isVideoStudioEnabled,
  unavailableReason: VIDEO_STUDIO_DISABLED_REASON,
  description:
    'Compose background music (Eleven Music, the user ElevenLabs key) and save ' +
    'an mp3 plus <name>.provenance.json inside the workspace. Instrumental by ' +
    'default; the provider signs the mp3 with C2PA. Describe genre, era, ' +
    'instruments, tempo and mood — never an artist, song or lyric (the ' +
    'provider refuses and returns promptSuggestion; show it to the operator ' +
    `before using it). lengthMs ${MUSIC_MIN_MS}–${MUSIC_MAX_MS}; ` +
    'match the narration durationMs from the timeline. dryRun:true prices it ' +
    '(US$ 0.15/min). The result carries the license notice to relay to the ' +
    'operator. Missing key → STOP and report Ajustes → Serviços de mídia.',
  inputSchema: {
    type: 'object',
    properties: {
      prompt: { type: 'string' },
      lengthMs: { type: 'number' },
      instrumental: { type: 'boolean', description: 'Default true.' },
      model: { type: 'string', enum: [...MUSIC_MODELS] },
      outPath: { type: 'string', description: 'Workspace .mp3 path (default music/music-<timestamp>.mp3).' },
      dryRun: { type: 'boolean' },
    },
    required: ['prompt', 'lengthMs'],
  },
  requiresConfirm: true,
  handler: async (args, ctx, invocation) => {
    assertMcpInvocationCurrent(invocation);
    const lengthMs = num(args, 'lengthMs');
    if (lengthMs === undefined) throw new Error('missing required argument: lengthMs');
    const prompt = str(args, 'prompt');
    if (!prompt) throw new Error('missing required argument: prompt');
    const spend =
      args.dryRun === true
        ? null
        : reserveMediaSpend({ provider: 'elevenlabs', usd: musicCostUsd(Math.round(lengthMs)) }, ctx.missionId, 'music_generate');
    if (spend && !spend.ok) return spend;
    let result: Awaited<ReturnType<typeof generateMusic>>;
    try {
      result = await generateMusic({
      prompt,
      lengthMs: Math.round(lengthMs),
      instrumental: args.instrumental !== false,
      model: str(args, 'model'),
      outPath: str(args, 'outPath'),
      dryRun: args.dryRun === true,
      baseDir: baseDirFor(ctx),
      signal: invocation?.signal,
      assertCurrentAuthority: invocation?.assertCurrentAuthority,
    });
    } catch (error) {
      spend?.release();
      throw error;
    }
    if (result.ok) spend?.settle(result.estimatedCostUsd);
    else spend?.release();
    assertMcpInvocationCurrent(invocation);
    if (result.ok && !result.dryRun && result.path) {
      await recordMediaUsage(
        {
          ok: true,
          path: result.path,
          provider: 'elevenlabs',
          model: result.model,
          kind: 'audio',
          estimatedCostUsd: result.estimatedCostUsd,
          durationMs: result.lengthMs,
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
  return [voiceListTool, voiceoverGenerateTool, musicGenerateTool];
}
