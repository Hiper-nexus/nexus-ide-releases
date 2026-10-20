import { assertMcpInvocationCurrent, type McpToolDef } from './mcp-protocol';
import {
  generateAudio,
  generateImage,
  generateVideo,
  MediaJobTimeoutError,
} from '../media/media-generation';
import {
  computeMediaTierAlternatives,
  defaultMediaChoices,
  listMediaProviders,
  MediaProviderUnavailableError,
} from '../media/media-providers';
import {
  listMediaModelAliases,
  listMediaModelAliasesByKind,
} from '../media/media-model-aliases';
import { hasMediaKey, maskedMediaKey } from '../media/media-keys';
import { recordMediaUsage } from '../usage/media-usage-recorder';
import { estimateMediaToolUsd, reserveMediaSpend } from '../media/media-budget';
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

/**
 * F-1598: o agente escolhe o modelo pelo que esta resposta traz — o cartão de
 * cada modelo de vídeo (as regras que o motor aplica antes de cobrar, o preço
 * de lista e o desligamento), o preço por imagem e o que roda sem provider.
 * Nada aqui fala de qualidade: o Nexus não mediu um modelo contra outro.
 */
const mediaProvidersTool: McpToolDef = {
  name: 'nexus_media_providers',
  description:
    'List media generation providers (image/video/audio), their models, ' +
    'whether an API key is configured, and friendly model aliases ' +
    '(seedream, seedance, veo, omni, kling, sora, runway, luma, grok…; ' +
    'aliasesByKind lists the ones that depend on the tool, e.g. "grok" is ' +
    'Grok Imagine Image in nexus_image_generate and Grok Imagine Video in ' +
    'nexus_video_generate). ' +
    'Image providers carry imageCostUsd (list USD per image, per model). ' +
    'Video providers carry videoModels, one card per model with the rules ' +
    'nexus_video_generate enforces before any charge: durationsSeconds ' +
    '(null = the model picks the length, so omit durationSeconds), ' +
    'durationsByResolution / durationsWithImage limits, resolutions and ' +
    'aspectRatios ([] = do not send that field), requiresImage, price ' +
    '(usd-per-second by resolution, or usd-per-video by resolution and ' +
    'seconds, or quoted-by-service = Higgsfield quotes each request and ' +
    'returns it as estimatedCostUsd; billedByTokensUsdPerMillion = billed by tokens, the per-second ' +
    'table is approximate), defaultRequestCostUsd, retiresOn/retired/' +
    'replacement. defaults = what runs when you omit provider and model. ' +
    'Prices are list prices, not quality: the Nexus has not measured model ' +
    'quality. Call before generating; never invent providers/models outside ' +
    'this list.',
  inputSchema: { type: 'object', properties: {} },
  handler: async () => ({
    providers: listMediaProviders(hasMediaKey, maskedMediaKey).map(
      ({ maskedKey: _masked, ...info }) => info,
    ),
    defaults: defaultMediaChoices(hasMediaKey),
    aliases: listMediaModelAliases(),
    aliasesByKind: listMediaModelAliasesByKind(),
  }),
};

const imageGenerateTool: McpToolDef = {
  name: 'nexus_image_generate',
  description:
    'Generate an image and save it in the workspace. Returns {path}. ' +
    'Choose with nexus_media_providers: imageCostUsd is the list price per ' +
    'image of each model; if the user named a model or provider, use it. ' +
    'Without provider/model the keyed provider with the lowest list price ' +
    'runs (see defaults there). Providers: google-image (Gemini Flash Image; ' +
    'aspectRatio 1:1|16:9|9:16|4:3|3:4|3:2|2:3) | openai-image (gpt-image-2/1; ' +
    'aspectRatio 1:1|16:9|9:16|4:3|3:4|3:2|2:3, mapped to its 3 sizes) | ' +
    'replicate-image (ByteDance Seedream 5.0 Pro; aliases: ' +
    'seedream, seedream-5-pro, seedream5-0-pro, seedream-lite). ' +
    'Seedream aspectRatio: match_input_image|1:1|4:3|3:4|16:9|9:16|3:2|2:3|21:9. ' +
    'Seedream size: 1K|2K only (default 2K). imagePath + ' +
    'referenceImagePaths[] → image_input (1–10 refs, Seedream ONLY — ' +
    'google/openai-image accept just imagePath). ' +
    'higgsfield-image (HIGGSFIELD_API_KEY ID:SECRET, price quoted per request): ' +
    'higgsfield/soul-2 (photo, text only), higgsfield/ideogram-4 (text and ' +
    'logos; imagePath remix), higgsfield/qwen-image-3 (edits up to 3 images: ' +
    'imagePath + referenceImagePaths), higgsfield/recraft-4.1 (text only) | ' +
    'xai-image (Grok Imagine Image 2.0 via the XAI_API_KEY; alias grok): ' +
    'imagePath edits that image; size 1K|1.5K|2K (grok-imagine-image: ' +
    '1K|2K); aspectRatio 1:1|16:9|9:16|4:3|3:4|3:2|2:3|2:1|1:2|21:9|5:2|' +
    '19.5:9|9:19.5|20:9|9:20|auto. ' +
    'Paths stay in the open workspace. Missing key → STOP and report ' +
    '"configure o provider em Ajustes → Serviços de mídia".',
  inputSchema: {
    type: 'object',
    properties: {
      prompt: { type: 'string' },
      provider: {
        type: 'string',
        enum: ['google-image', 'openai-image', 'replicate-image', 'xai-image', 'higgsfield-image'],
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
    // F-1606: the media spend cap is checked before the provider is called.
    const spend = reserveMediaSpend(estimateMediaToolUsd('image_generate', args, hasMediaKey), ctx.missionId, 'image_generate');
    if (!spend.ok) return spend;
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
      spend.settle(result.estimatedCostUsd);
      assertMcpInvocationCurrent(invocation);
      await recordMediaUsage(result, ctx, invocation);
      assertMcpInvocationCurrent(invocation);
      return result;
    } catch (err) {
      spend.release();
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
    'Choose with nexus_media_providers → videoModels, the same rules this ' +
    'tool enforces (a request outside them is refused before any charge): ' +
    'pick a model whose durationsSeconds, resolutions and aspectRatios fit ' +
    'the brief, that needs no image you lack (requiresImage) and is not ' +
    'retired, then compare price; if the user named a model or provider, use ' +
    'it. Cost = seconds × the per-second price at the resolution, or the ' +
    'per-video price. Without provider/model the keyed provider whose default ' +
    'request has the lowest list price runs (see defaults there). ' +
    'Providers: replicate-video (Seedance 2.0 default; also Veo 3.1, Kling, ' +
    'Hailuo, Wan, Sora 2, Runway, Luma Ray) | google-video (Gemini API key: ' +
    'default gemini-omni-1.1-flash — the model picks the clip length, so omit ' +
    'durationSeconds; it bills tokens, close to the per-second table; ' +
    'resolution 360p|720p|1080p|4k) | xai-video (Grok Imagine via the ' +
    'XAI_API_KEY: default grok-imagine-video-1.5, also -1.5-lite and ' +
    'grok-imagine-video; durationSeconds 1–15; resolution 480p|720p|1080p, ' +
    'grok-imagine-video up to 720p; aspectRatio 16:9|9:16|1:1|4:3|3:4|3:2|' +
    '2:3|21:9|5:2, ignored with imagePath (the clip follows the image); ' +
    'references or endImagePath cap at 720p; prompt is optional when an ' +
    'image input is given; each input image is billed: see inputImageUsd). ' +
    'The native Veo 3.1 previews ' +
    '(veo-3.1-*-generate-preview) retire on 2026-10-22: use Omni, or ' +
    'google/veo-3.1 via Replicate. ' +
    'Newest on replicate-video (2026-08/09): bytedance/seedance-2.5 (4–30 s, ' +
    '480p|720p, up to 30 refs), minimax/h3 (Hailuo 3, 768p|2k), alibaba/wan-3 ' +
    'and alibaba/wan-3-prime (2–30 s), google/gemini-omni-1.1 (model picks the ' +
    'duration), pixverse/pixverse-v6, vidu/q3-pro (1–16 s); Kling 4 is not on ' +
    'any API yet. ' +
    'higgsfield-video (HIGGSFIELD_API_KEY as ID:SECRET; price quoted by ' +
    'Higgsfield per request, returned as estimatedCostUsd): ' +
    'higgsfield/seedance-2.5 (4–30 s, up to 1080p), higgsfield/seedance-2.0 ' +
    '(up to 4k), higgsfield/kling-3.0-pro (3–15 s), higgsfield/minimax-h3 ' +
    '(5–15 s, 2K), higgsfield/wan-3.0 (2–30 s); the flow follows the inputs ' +
    '(text, imagePath, or references) and referenceVideoPaths[] (example ' +
    'video: motion/style; cite as [Video1]) works only here — up to 10 on ' +
    'Seedance 2.5, 3 on Seedance 2.0 and H3, 5 on Wan 3.0, none on Kling; ' +
    'first frame and references never mix. ' +
    'Friendly model aliases work: seedance, seedance-2.5, veo, omni, kling, ' +
    'h3, hailuo-3, wan-3, pixverse, vidu, sora, runway, luma, grok. ' +
    'imagePath=first frame; endImagePath=last frame (Seedance, Veo, Kling, ' +
    'Luma, H3, PixVerse, Vidu, google-video — Omni needs imagePath with it — ' +
    'and only grok-imagine-video-1.5 on xai-video); referenceImagePaths[] for ' +
    'character refs: max 9 on Seedance 2.0 and google-video, 30 on Seedance ' +
    '2.5, 1–3 on google/veo-3.1 (16:9 and 8 s only; none on veo-3.1-fast/lite), ' +
    '9 on Gemini Omni 1.1, none on H3/Wan 3/PixVerse/Vidu ' +
    '(refused before paying); on xai-video up to 14 on 1.5, 7 on ' +
    'grok-imagine-video (max 10 s), none on lite. On ' +
    'timeout the error includes recoverJobId — call again with that id to ' +
    'resume without double charge. Paths stay in the open workspace. ' +
    'Missing key → STOP and report Ajustes → Serviços de mídia.',
  inputSchema: {
    type: 'object',
    properties: {
      prompt: { type: 'string' },
      provider: {
        type: 'string',
        enum: ['replicate-video', 'google-video', 'xai-video', 'higgsfield-video'],
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
      referenceVideoPaths: {
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
    // xai-video aceita vídeo só a partir de imagem (prompt opcional com
    // imagePath/endImagePath/referenceImagePaths); o motor recusa os demais.
    const hasImageInput = Boolean(
      str(args, 'imagePath') ||
        str(args, 'endImagePath') ||
        (strArray(args, 'referenceImagePaths') ?? []).length > 0,
    );
    if (!recoverJobId && !prompt && !hasImageInput) {
      throw new Error('missing required argument: prompt (or recoverJobId, or an image input on xai-video)');
    }
    const spend = reserveMediaSpend(estimateMediaToolUsd('video_generate', args, hasMediaKey), ctx.missionId, 'video_generate');
    if (!spend.ok) return spend;
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
        referenceVideoPaths: strArray(args, 'referenceVideoPaths'),
        recoverJobId,
        baseDir: baseDirFor(ctx),
        signal: invocation?.signal,
        assertCurrentAuthority: invocation?.assertCurrentAuthority,
      });
      spend.settle(result.estimatedCostUsd);
      assertMcpInvocationCurrent(invocation);
      await recordMediaUsage(result, ctx, invocation);
      assertMcpInvocationCurrent(invocation);
      return result;
    } catch (err) {
      // A timed-out job keeps running at the provider: its cost stays reserved.
      if (err instanceof MediaJobTimeoutError) spend.settle();
      else spend.release();
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
    const spend = reserveMediaSpend(estimateMediaToolUsd('audio_generate', args, hasMediaKey), ctx.missionId, 'audio_generate');
    if (!spend.ok) return spend;
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
      spend.settle(result.estimatedCostUsd);
      assertMcpInvocationCurrent(invocation);
      await recordMediaUsage(result, ctx, invocation);
      assertMcpInvocationCurrent(invocation);
      return result;
    } catch (err) {
      spend.release();
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
