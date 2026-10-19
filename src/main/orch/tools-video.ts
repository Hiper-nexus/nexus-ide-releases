import { app } from 'electron';
import { assertMcpInvocationCurrent, type McpToolDef } from './mcp-protocol';
import { acquireHeavyCommandPermit } from './heavy-command-permit';
import { executionScopeFor, isHardenedPolicyActive, type AgentGateContext } from './gate';
import { num, requireStr, str } from './tool-util';
import { resolveCwdForScope } from './workspace-path';
import { getEffectivePath, lookupInPath } from '../path-resolver';
import { bundledEngineManifestDir, HYPERFRAMES_VERSION } from '../video/video-engine';
import { runVideoDoctor } from '../video/video-doctor';
import { renderVideo, type RenderDeps } from '../video/video-render';
import { exportVideo } from '../video/video-export';
import { VIDEO_EXPORT_PRESET_IDS, type VideoExportPresetId } from '../../shared/video-export-presets';
import { videoEnginePaths } from '../video/video-engine';

/**
 * Video studio tools (F-1594): check the machine and render a HyperFrames
 * project of the open workspace with the engine version the Nexus pins.
 * The agent writes the composition in its pane; the Nexus owns install,
 * clean environment, reservation, cancellation and the ffprobe proof.
 */

function baseDirFor(ctx: AgentGateContext): string {
  return resolveCwdForScope(executionScopeFor(ctx));
}

export function videoRenderDeps(): RenderDeps {
  const pathValue = getEffectivePath();
  return {
    userData: app.getPath('userData'),
    manifestDir: bundledEngineManifestDir(),
    pathValue,
    baseEnv: process.env,
    lookup: (command) => lookupInPath(command, pathValue),
    acquirePermit: acquireHeavyCommandPermit,
    isHardened: isHardenedPolicyActive,
    now: () => new Date(),
  };
}

const videoDoctorTool: McpToolDef = {
  name: 'nexus_video_doctor',
  description:
    'Check what a video render needs on this machine, read-only: Node.js 22+, npm, ffmpeg, ffprobe, ' +
    `the pinned HyperFrames ${HYPERFRAMES_VERSION} engine, its Chrome, free disk and (Windows) path length. ` +
    'Each failing check carries the command that fixes it; relay it to the operator, never run installs ' +
    'yourself without asking.',
  inputSchema: { type: 'object', properties: {} },
  handler: async (_args, ctx, invocation) => {
    assertMcpInvocationCurrent(invocation);
    const deps = videoRenderDeps();
    const { node: _node, ...report } = await runVideoDoctor({
      userData: deps.userData,
      manifestDir: deps.manifestDir,
      workspaceDir: baseDirFor(ctx),
      pathValue: deps.pathValue,
      baseEnv: deps.baseEnv,
      lookup: deps.lookup,
    });
    return report;
  },
};

const videoRenderTool: McpToolDef = {
  name: 'nexus_video_render',
  description:
    `Render a HyperFrames project of the workspace to MP4 with the pinned engine (hyperframes ${HYPERFRAMES_VERSION}), ` +
    'clean environment (no API keys, no telemetry) and the machine-wide heavy-command reservation. The first ' +
    'render installs the engine (~110 MB) and its Chrome (~120 MB). projectDir = folder with hyperframes.json or ' +
    'index.html. Remotion projects are refused (license). Before rendering: `npx hyperframes@' +
    `${HYPERFRAMES_VERSION} check` + '` with no errors and snapshots reviewed. The result is read back with ' +
    'ffprobe (duration, size, codecs) and lists any network access the render made (fonts/CDN must be local). ' +
    'Then call nexus_video_export for each network.',
  inputSchema: {
    type: 'object',
    properties: {
      projectDir: { type: 'string', description: 'Project folder inside the workspace.' },
      output: { type: 'string', description: 'Workspace .mp4 path (default <projectDir>/renders/<name>-<stamp>.mp4).' },
      quality: { type: 'string', enum: ['draft', 'final'], description: 'draft = fast preview; final (default) = engine default quality.' },
      fps: { type: 'number' },
      timeoutMinutes: { type: 'number', description: '1–60, default 20.' },
    },
    required: ['projectDir'],
  },
  requiresConfirm: true,
  handler: async (args, ctx, invocation) => {
    assertMcpInvocationCurrent(invocation);
    const quality = str(args, 'quality');
    const result = await renderVideo(
      {
        projectDir: requireStr(args, 'projectDir'),
        output: str(args, 'output'),
        quality: quality === 'draft' ? 'draft' : 'final',
        fps: num(args, 'fps'),
        timeoutMinutes: num(args, 'timeoutMinutes'),
        baseDir: baseDirFor(ctx),
        scope: executionScopeFor(ctx),
        missionId: ctx.missionId,
        sessionId: ctx.sessionId,
        signal: invocation?.signal,
        assertCurrentAuthority: () => assertMcpInvocationCurrent(invocation),
      },
      videoRenderDeps(),
    );
    assertMcpInvocationCurrent(invocation);
    return result;
  },
};

const videoExportTool: McpToolDef = {
  name: 'nexus_video_export',
  description:
    'Export a rendered MP4 of the workspace for a network: preset size and fps, H.264 High yuv420p, AAC 48 kHz, ' +
    '+faststart, loudness in two passes to -14 LUFS / -1 dBTP (measured again on the output), a mute version, a PNG ' +
    'cover, the narration .srt/.vtt beside it, IPTC DigitalSourceType metadata and a provenance JSON. label auto ' +
    '(default) burns "Narração com voz gerada por IA" for the first seconds when the narration voice is a clone; ' +
    `relay label and publishChecklist to the operator. Presets: ${VIDEO_EXPORT_PRESET_IDS.join(', ')}.`,
  inputSchema: {
    type: 'object',
    properties: {
      input: { type: 'string', description: 'Rendered .mp4 inside the workspace.' },
      preset: { type: 'string', enum: [...VIDEO_EXPORT_PRESET_IDS] },
      projectDir: { type: 'string', description: 'Project folder (default: nearest folder with hyperframes.json above input).' },
      label: { type: 'string', enum: ['auto', 'on', 'off'] },
      labelSeconds: { type: 'number', description: 'Seconds the AI label stays on screen; 0 = whole video. Default 6.' },
      coverAtSec: { type: 'number' },
      outDir: { type: 'string', description: 'Workspace folder (default <project>/exports).' },
    },
    required: ['input', 'preset'],
  },
  requiresConfirm: true,
  handler: async (args, ctx, invocation) => {
    assertMcpInvocationCurrent(invocation);
    const preset = requireStr(args, 'preset');
    if (!(VIDEO_EXPORT_PRESET_IDS as string[]).includes(preset)) {
      throw new Error(`preset desconhecido: ${preset} (use ${VIDEO_EXPORT_PRESET_IDS.join(', ')})`);
    }
    const label = str(args, 'label');
    const deps = videoRenderDeps();
    const result = await exportVideo(
      {
        input: requireStr(args, 'input'),
        preset: preset as VideoExportPresetId,
        projectDir: str(args, 'projectDir'),
        label: label === 'on' || label === 'off' ? label : 'auto',
        labelSeconds: num(args, 'labelSeconds'),
        coverAtSec: num(args, 'coverAtSec'),
        outDir: str(args, 'outDir'),
        baseDir: baseDirFor(ctx),
        scope: executionScopeFor(ctx),
        missionId: ctx.missionId,
        sessionId: ctx.sessionId,
        signal: invocation?.signal,
        assertCurrentAuthority: () => assertMcpInvocationCurrent(invocation),
      },
      {
        pathValue: deps.pathValue,
        baseEnv: deps.baseEnv,
        lookup: deps.lookup,
        acquirePermit: deps.acquirePermit,
        home: videoEnginePaths(deps.userData).home,
      },
    );
    assertMcpInvocationCurrent(invocation);
    return result;
  },
};

export function buildVideoTools(): McpToolDef[] {
  return [videoDoctorTool, videoRenderTool, videoExportTool];
}
