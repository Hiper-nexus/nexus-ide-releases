import { assertMcpInvocationCurrent, type McpToolDef } from './mcp-protocol';
import {
  generateAudio,
  generateImage,
  generateVideo,
  MediaJobTimeoutError,
} from '../media/media-generation';
import {
  computeMediaTierAlternatives,
  listMediaProviders,
  MediaProviderUnavailableError,
} from '../media/media-providers';
import { listMediaModelAliases } from '../media/media-model-aliases';
import { hasMediaKey, maskedMediaKey } from '../media/media-keys';
import { recordMediaUsage } from '../usage/media-usage-recorder';
import { num, requireStr, str, strArray } from './tool-util';
import { resolveCwdForScope } from './workspace-path';
import type { AgentGateContext } from './gate';
import { executionScopeFor } from './gate';

/**
 * Media generation MCP tools — image/video/audio providers become tools any
 * squad agent can fire. Keys stay in the main process (encrypted vault); the
 * agent only receives the path of the generated file in the workspace.
 */

/**
 * Media is intentionally workspace-bound. Without an active workspace the
 * operation fails closed instead of reading/writing a global fallback path.
 */
function baseDirFor(ctx: AgentGateContext): string {
  return resolveCwdForScope(executionScopeFor(ctx));
}

const mediaProvidersTool: McpToolDef = {
  name: 'nexus_media_providers',
  description:
    'List media generation providers (image/video/audio), their models, ' +
    'whether an API key is configured, and friendly model aliases ' +
    '(seedream, seedance, veo, omni, kling, sora, runway, luma…). Call before ' +
    'generating; never invent providers/models outside this list.',
  inputSchema: { type: 'object', properties: {} },
  handler: async () => ({
    providers: listMediaProviders(hasMediaKey, maskedMediaKey).map(
      ({ maskedKey: _masked, ...info }) => info,
    ),
    aliases: listMediaModelAliases(),
  }),
};

const imageGenerateTool: McpToolDef = {
  name: 'nexus_image_generate',
  description:
    'Generate an image and save it in the workspace. Returns {path}. ' +
    'Providers: google-image (default/cheap) | openai-image | ' +
    'replicate-image (ByteDance Seedream 5.0 Pro — flagship multimodal ' +
    'image; official seed.bytedance.com/en/seedream5_0_pro; aliases: ' +
    'seedream, seedream-5-pro, seedream5-0-pro, seedream-lite). ' +
    'Seedream aspectRatio: match_input_image|1:1|4:3|3:4|16:9|9:16|3:2|2:3|21:9. ' +
    'Seedream size: 1K|2K only (default 2K). imagePath + ' +
    'referenceImagePaths[] → image_input (1–10 refs, Seedream ONLY — ' +
    'google/openai-image accept just imagePath). ' +
    'Paths stay in the open workspace. Missing key → STOP and report ' +
    '"configure o provider em Ajustes → Serviços de mídia".',
  inputSchema: {
    type: 'object',
    properties: {
      prompt: { type: 'string' },
      provider: {
        type: 'string',
        enum: ['google-image', 'openai-image', 'replicate-image'],
      },
      model: { type: 'string' },
      outPath: { type: 'string' },
      imagePath: { type: 'string' },
      referenceImagePaths: {
        type: 'array',
        items: { type: 'string' },
      },
      aspectRatio: { type: 'string' },
      size: { type: 'string' },
    },
    required: ['prompt'],
  },
  requiresConfirm: true,
  handler: async (args, ctx, invocation) => {
    assertMcpInvocationCurrent(invocation);
    try {
      const result = await generateImage({
        prompt: requireStr(args, 'prompt'),
        provider: str(args, 'provider'),
        model: str(args, 'model'),
        outPath: str(args, 'outPath'),
        imagePath: str(args, 'imagePath'),
        referenceImagePaths: strArray(args, 'referenceImagePaths'),
        aspectRatio: str(args, 'aspectRatio'),
        size: str(args, 'size'),
        baseDir: baseDirFor(ctx),
        signal: invocation?.signal,
        assertCurrentAuthority: invocation?.assertCurrentAuthority,
      });
      assertMcpInvocationCurrent(invocation);
      await recordMediaUsage(result, ctx, invocation);
      assertMcpInvocationCurrent(invocation);
      return result;
    } catch (err) {
      if (err instanceof MediaProviderUnavailableError) {
        return {
          ok: false,
          error: err.message,
          tierAlternatives: computeMediaTierAlternatives(
            err.requestedKind,
            err.message,
            hasMediaKey,
          ),
        };
      }
      throw err;
    }
  },
};

const videoGenerateTool: McpToolDef = {
  name: 'nexus_video_generate',
  description:
    'Generate a video clip and save the mp4 in the workspace. ' +
    'Providers: replicate-video (default Seedance 2.0; also Veo/Kling/Sora/' +
    'Runway/Luma) | google-video (Gemini API key: default Gemini Omni Flash, ' +
    'which picks the clip length itself — omit durationSeconds; resolution ' +
    '360p|720p|1080p|4k; the Veo 3.1 previews retire on 2026-10-22). ' +
    'Friendly model aliases work: seedance, veo, omni, kling, sora, runway, luma. ' +
    'imagePath=first frame; endImagePath=last frame; referenceImagePaths[] ' +
    'for Seedance/Veo character refs (max 9). On timeout the error includes ' +
    'recoverJobId — call again with that id to resume without double charge. ' +
    'Call nexus_media_providers first. Paths stay in the open workspace. ' +
    'Missing key → STOP and report Ajustes → Serviços de mídia.',
  inputSchema: {
    type: 'object',
    properties: {
      prompt: { type: 'string' },
      provider: {
        type: 'string',
        enum: ['replicate-video', 'google-video'],
      },
      model: { type: 'string' },
      outPath: { type: 'string' },
      durationSeconds: { type: 'number' },
      resolution: { type: 'string' },
      aspectRatio: { type: 'string' },
      imagePath: { type: 'string' },
      endImagePath: { type: 'string' },
      referenceImagePaths: {
        type: 'array',
        items: { type: 'string' },
      },
      recoverJobId: { type: 'string' },
    },
    // prompt required unless recovering a job
    required: [],
  },
  requiresConfirm: true,
  handler: async (args, ctx, invocation) => {
    assertMcpInvocationCurrent(invocation);
    const recoverJobId = str(args, 'recoverJobId');
    const prompt = str(args, 'prompt');
    if (!recoverJobId && !prompt) {
      throw new Error('missing required argument: prompt (or recoverJobId)');
    }
    try {
      const result = await generateVideo({
        prompt: prompt ?? '',
        provider: str(args, 'provider'),
        model: str(args, 'model'),
        outPath: str(args, 'outPath'),
        durationSeconds: num(args, 'durationSeconds'),
        resolution: str(args, 'resolution'),
        aspectRatio: str(args, 'aspectRatio'),
        imagePath: str(args, 'imagePath'),
        endImagePath: str(args, 'endImagePath'),
        referenceImagePaths: strArray(args, 'referenceImagePaths'),
        recoverJobId,
        baseDir: baseDirFor(ctx),
        signal: invocation?.signal,
        assertCurrentAuthority: invocation?.assertCurrentAuthority,
      });
      assertMcpInvocationCurrent(invocation);
      await recordMediaUsage(result, ctx, invocation);
      assertMcpInvocationCurrent(invocation);
      return result;
    } catch (err) {
      assertMcpInvocationCurrent(invocation);
      if (err instanceof MediaJobTimeoutError) {
        return {
          ok: false,
          error: err.message,
          jobId: err.jobId,
          recoverJobId: err.jobId,
          provider: err.provider,
        };
      }
      if (err instanceof MediaProviderUnavailableError) {
        return {
          ok: false,
          error: err.message,
          tierAlternatives: computeMediaTierAlternatives(
            err.requestedKind,
            err.message,
            hasMediaKey,
          ),
        };
      }
      throw err;
    }
  },
};

const audioGenerateTool: McpToolDef = {
  name: 'nexus_audio_generate',
  description:
    'Generate speech audio (TTS) from text via ElevenLabs and save the mp3 ' +
    'inside the open workspace. Returns {path}. voiceId optional (default Rachel). ' +
    'If the key is missing, STOP and report "configure o provider em ' +
    'Ajustes → Serviços de mídia".',
  inputSchema: {
    type: 'object',
    properties: {
      text: { type: 'string' },
      provider: { type: 'string', enum: ['elevenlabs'] },
      model: { type: 'string' },
      voiceId: { type: 'string' },
      outPath: { type: 'string' },
    },
    required: ['text'],
  },
  requiresConfirm: true,
  handler: async (args, ctx, invocation) => {
    assertMcpInvocationCurrent(invocation);
    try {
      const result = await generateAudio({
        text: requireStr(args, 'text'),
        provider: str(args, 'provider'),
        model: str(args, 'model'),
        voiceId: str(args, 'voiceId'),
        outPath: str(args, 'outPath'),
        baseDir: baseDirFor(ctx),
        signal: invocation?.signal,
        assertCurrentAuthority: invocation?.assertCurrentAuthority,
      });
      assertMcpInvocationCurrent(invocation);
      await recordMediaUsage(result, ctx, invocation);
      assertMcpInvocationCurrent(invocation);
      return result;
    } catch (err) {
      if (err instanceof MediaProviderUnavailableError) {
        return {
          ok: false,
          error: err.message,
          tierAlternatives: computeMediaTierAlternatives(
            err.requestedKind,
            err.message,
            hasMediaKey,
          ),
        };
      }
      throw err;
    }
  },
};

export function buildMediaTools(): McpToolDef[] {
  return [
    mediaProvidersTool,
    imageGenerateTool,
    videoGenerateTool,
    audioGenerateTool,
  ];
}
