import fs from 'node:fs';
import path from 'node:path';

function exists(root: string, rel: string): boolean {
  try {
    return fs.existsSync(path.join(root, rel));
  } catch {
    return false;
  }
}

export function detectWorkspaceStacks(workspacePath?: string): string[] {
  if (!workspacePath) return [];
  const root = path.resolve(workspacePath);
  const stacks = new Set<string>();
  if (exists(root, 'package.json')) {
    stacks.add('node');
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      if (deps.react) stacks.add('react');
      if (deps.electron) stacks.add('electron');
      if (deps.vite) stacks.add('vite');
      if (deps['@xyflow/react']) stacks.add('canvas-ui');
    } catch {
      // Invalid package.json should not break the overlay.
    }
  }
  if (exists(root, 'tsconfig.json')) stacks.add('typescript');
  if (exists(root, 'pyproject.toml') || exists(root, 'requirements.txt')) {
    stacks.add('python');
  }
  if (exists(root, 'go.mod')) stacks.add('go');
  if (exists(root, 'Cargo.toml')) stacks.add('rust');
  return [...stacks].sort();
}
