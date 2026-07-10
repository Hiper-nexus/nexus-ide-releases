import type { McpToolDef } from './mcp-protocol';
import {
  generateAudio,
  generateImage,
  generateVideo,
} from '../media/media-generation';
import { listMediaProviders } from '../media/media-providers';
import { hasMediaKey, maskedMediaKey } from '../media/media-keys';
import { recordMediaUsage } from '../usage/media-usage-recorder';
import { num, requireStr, str } from './tool-util';
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
    'List media generation providers (image/video/audio), their models and ' +
    'whether an API key is configured. Call before generating to know what ' +
    'is available; never invent providers/models outside this list.',
  inputSchema: { type: 'object', properties: {} },
  handler: async () =>
    listMediaProviders(hasMediaKey, maskedMediaKey).map(
      ({ maskedKey: _masked, ...info }) => info,
    ),
};

const imageGenerateTool: McpToolDef = {
  name: 'nexus_image_generate',
  description:
    'Generate an image from a prompt and save it in the workspace. Returns ' +
    '{path}. provider: google-image (default, cheapest) | openai-image. ' +
    'All input/output paths must remain inside the open workspace; use a ' +
    'relative outPath (e.g. "assets/hero.png"). Pass imagePath for ' +
    'image-to-image edits. If the key is missing, STOP and ' +
    'report "configure o provider em Settings → Mídia" — never invent env vars.',
  inputSchema: {
    type: 'object',
    properties: {
      prompt: { type: 'string' },
      provider: { type: 'string', enum: ['google-image', 'openai-image'] },
      model: { type: 'string' },
      outPath: { type: 'string' },
      imagePath: { type: 'string' },
    },
    required: ['prompt'],
  },
  requiresConfirm: true,
  handler: async (args, ctx) => {
    const result = await generateImage({
      prompt: requireStr(args, 'prompt'),
      provider: str(args, 'provider'),
      model: str(args, 'model'),
      outPath: str(args, 'outPath'),
      imagePath: str(args, 'imagePath'),
      baseDir: baseDirFor(ctx),
    });
    await recordMediaUsage(result, ctx);
    return result;
  },
};

const videoGenerateTool: McpToolDef = {
  name: 'nexus_video_generate',
  description:
    'Generate a video clip from a prompt via Replicate (Seedance default; ' +
    'Kling supports start+end keyframes via imagePath/endImagePath). Waits ' +
    'for completion (up to 6 min) and saves the mp4 in the workspace. ' +
    'Every input/output path must remain inside the open workspace. Returns ' +
    '{path}. If the key is missing, STOP and report "configure o ' +
    'provider em Settings → Mídia".',
  inputSchema: {
    type: 'object',
    properties: {
      prompt: { type: 'string' },
      provider: { type: 'string', enum: ['replicate-video'] },
      model: { type: 'string' },
      outPath: { type: 'string' },
      durationSeconds: { type: 'number' },
      resolution: { type: 'string' },
      aspectRatio: { type: 'string' },
      imagePath: { type: 'string' },
      endImagePath: { type: 'string' },
    },
    required: ['prompt'],
  },
  requiresConfirm: true,
  handler: async (args, ctx) => {
    const result = await generateVideo({
      prompt: requireStr(args, 'prompt'),
      provider: str(args, 'provider'),
      model: str(args, 'model'),
      outPath: str(args, 'outPath'),
      durationSeconds: num(args, 'durationSeconds'),
      resolution: str(args, 'resolution'),
      aspectRatio: str(args, 'aspectRatio'),
      imagePath: str(args, 'imagePath'),
      endImagePath: str(args, 'endImagePath'),
      baseDir: baseDirFor(ctx),
    });
    await recordMediaUsage(result, ctx);
    return result;
  },
};

const audioGenerateTool: McpToolDef = {
  name: 'nexus_audio_generate',
  description:
    'Generate speech audio (TTS) from text via ElevenLabs and save the mp3 ' +
    'inside the open workspace. Returns {path}. voiceId optional (default Rachel). ' +
    'If the key is missing, STOP and report "configure o provider em ' +
    'Settings → Mídia".',
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
  handler: async (args, ctx) => {
    const result = await generateAudio({
      text: requireStr(args, 'text'),
      provider: str(args, 'provider'),
      model: str(args, 'model'),
      voiceId: str(args, 'voiceId'),
      outPath: str(args, 'outPath'),
      baseDir: baseDirFor(ctx),
    });
    await recordMediaUsage(result, ctx);
    return result;
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
