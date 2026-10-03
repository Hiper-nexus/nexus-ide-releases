import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { ProjectRuntimeManager } from '../runtime/project-runtime-manager';
import { testProjectScope } from '../orch/__tests__/scope-fixture';
import { configureProjectDomainStoreRegistry, disposeProjectDomainStoreRegistry } from '../orch/project-domain-store-registry';
import { configureWorkspaceMemory, disposeWorkspaceMemoryStores, getWorkspaceMemoryStore } from './workspace-memory';

let root: string;
const managers: ProjectRuntimeManager[] = [];
let releaseIo = () => {};
afterEach(async () => {
  releaseIo();
  await disposeProjectDomainStoreRegistry();
  vi.restoreAllMocks(); disposeWorkspaceMemoryStores();
  for (const manager of managers.splice(0)) manager.closeAll();
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

function fixture() {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'memory-service-flight-')));
  const scope = testProjectScope({ rootRealPath: root });
  const file = path.join(root, 'src/flight.ts');
  fs.mkdirSync(path.dirname(file)); fs.writeFileSync(file, 'export {}');
  configureWorkspaceMemory({ baseDir: path.join(root, 'bank'), coordinationScopeFor: () => scope });
  const store = getWorkspaceMemoryStore(scope);
  const id = store.retain({ content: 'Fact linked to src/flight.ts', kind: 'fact', source: 'trusted:resolved-problem' }).id;
  let resolve!: (value: string) => void;
  const physical = new Promise<string>((yes) => { resolve = yes; });
  releaseIo = () => resolve(file);
  let calls = 0;
  const original = fs.promises.realpath.bind(fs.promises);
  vi.spyOn(fs.promises, 'realpath').mockImplementation((candidate, options) => {
    if (String(candidate) === file) { calls++; return physical; }
    return original(candidate, options);
  });
  const manager = (name: string) => {
    const runtime = new ProjectRuntimeManager({ baseDir: path.join(root, name), appVersion: 'test' });
    managers.push(runtime); return runtime;
  };
  return { scope, store, id, manager, calls: () => calls };
}

it('registry disposal waits for actual maintenance IO before clearing stores', async () => {
  const f = fixture();
  const registry = configureProjectDomainStoreRegistry(f.manager('runtime-a'));
  registry.forScope(f.scope);
  await vi.waitFor(() => expect(f.calls()).toBe(1));
  let completed = false;
  const shutdown = disposeProjectDomainStoreRegistry().then(() => { completed = true; });
  await Promise.resolve(); await Promise.resolve();
  expect(completed).toBe(false);
  expect(registry.listSuites()).toHaveLength(1);
  releaseIo(); await shutdown;
  expect(registry.listSuites()).toHaveLength(0);
  expect(f.store.flagsOf([f.id]).size).toBe(0);
});

it.each(['replacement', 'dispose-then-open'])('%s does not start a new epoch while old physical maintenance is pending', async (kind) => {
  const f = fixture();
  const old = configureProjectDomainStoreRegistry(f.manager('runtime-a')); old.forScope(f.scope);
  await vi.waitFor(() => expect(f.calls()).toBe(1));
  const stopping = kind === 'dispose-then-open' ? disposeProjectDomainStoreRegistry() : undefined;
  const next = configureProjectDomainStoreRegistry(f.manager('runtime-b')); next.forScope(f.scope);
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(old.listSuites()).toHaveLength(1);
  expect(f.calls()).toBe(1);
  releaseIo();
  await stopping;
  await vi.waitFor(() => expect(f.calls()).toBe(2));
  expect(old.listSuites()).toHaveLength(0);
  expect(f.store.flagsOf([f.id]).size).toBe(0);
});
