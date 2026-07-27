import type { McpToolDef } from './mcp-protocol';
import {
  formatWorkspaceDependencies,
  resolveWorkspaceDependencies,
  type WorkspaceDependencies,
} from './workspace-dependencies';

type DependencyResolver = () => WorkspaceDependencies;

/** Compatibility bridge for Codex skills launched outside Codex Desktop. */
export function buildWorkspaceDependencyTools(
  resolve: DependencyResolver = resolveWorkspaceDependencies,
): McpToolDef[] {
  return [
    {
      // Keep the Desktop name: bundled skills refer to this exact capability.
      name: 'load_workspace_dependencies',
      description:
        'Load exact bundled runtime paths for Python/Pillow, Node.js, pnpm and Git. ' +
        'Call this before nexus-pet-studio or any skill that requires workspace dependencies.',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
      handler: async () => formatWorkspaceDependencies(resolve()),
    },
  ];
}
