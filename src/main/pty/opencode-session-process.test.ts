import { expect, it, vi } from 'vitest';
import { prepareOpenCodeSessionArgs } from './opencode-session-process';
const file = '/finite/opencode';
it.each([{ args: [] }, { args: ['run', 'finite prompt', '--model', 'finite/finite'] }, { args: ['--session', 'finite-session'] }])('OpenCode2 keeps original interactive/headless/resume args and gets its owned server', async ({ args }) => {
 const probe = vi.fn(); expect(await prepareOpenCodeSessionArgs(file, args, '/finite', { cached: () => '2.0.20', probe })).toEqual([...args, '--standalone']); expect(probe).not.toHaveBeenCalled();
});
it('OpenCode1 receives no unsupported flag and retains model/permission/resume arguments', async () => {
 const args = ['run', 'finite prompt', '--model', 'finite', '--session', 'finite', '--auto']; expect(await prepareOpenCodeSessionArgs(file, args, '/finite', { cached: () => '1.2.3', probe: vi.fn() })).toEqual(args);
});
it('a cold probe is asynchronous and its result must still be cached for this exact installation', async () => {
 let version: string | undefined, finish!: () => void;
 const probe = vi.fn(() => new Promise<string>(resolve => { finish = () => { version = '2.0.20'; resolve(version); }; }));
 const pending = prepareOpenCodeSessionArgs(file, [], '/finite/PATH', { cached: () => version, probe }); expect(probe).toHaveBeenCalledWith(file, '/finite/PATH'); finish(); expect(await pending).toEqual(['--standalone']);
 await expect(prepareOpenCodeSessionArgs(file, [], '/finite', { cached: () => undefined, probe: async () => '2.0.20' })).rejects.toThrow('version_unproved');
});
it('unknown versions and an external shared service fail before changing or launching anything', async () => {
 await expect(prepareOpenCodeSessionArgs(file, [], '/finite', { cached: () => null, probe: vi.fn() })).rejects.toThrow('version_unproved');
 await expect(prepareOpenCodeSessionArgs(file, ['--server=http://127.0.0.1:1'], '/finite', { cached: () => '2.0.20', probe: vi.fn() })).rejects.toThrow('not_pane_owned');
 expect(await prepareOpenCodeSessionArgs(file, ['--standalone'], '/finite', { cached: () => '2.0.20', probe: vi.fn() })).toEqual(['--standalone']);
});
