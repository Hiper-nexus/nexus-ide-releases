import { describe, expect, it } from 'vitest';
import {
  isDestructive,
  requiresConfirmation,
  confirmationReason,
} from '../../jarvis/guardrails';

describe('isDestructive', () => {
  it('flags rm -rf variants', () => {
    expect(isDestructive('rm -rf /tmp/foo')).toBe(true);
    expect(isDestructive('rm   -rf   /tmp/foo')).toBe(true);
    expect(isDestructive('sudo rm -rf /')).toBe(true);
  });

  it('flags git push --force', () => {
    expect(isDestructive('git push --force origin main')).toBe(true);
    expect(isDestructive('git push -f origin main')).toBe(true);
  });

  it('flags git reset --hard', () => {
    expect(isDestructive('git reset --hard HEAD~1')).toBe(true);
  });

  it('flags sudo commands', () => {
    expect(isDestructive('sudo npm install -g')).toBe(true);
    expect(isDestructive('sudo rm file')).toBe(true);
  });

  it('flags dd commands', () => {
    expect(isDestructive('dd if=/dev/zero of=/dev/sda')).toBe(true);
  });

  it('flags SQL DROP/DELETE', () => {
    expect(isDestructive('DROP TABLE users;')).toBe(true);
    expect(isDestructive('drop database mydb;')).toBe(true);
    expect(isDestructive('DELETE FROM users WHERE 1=1')).toBe(true);
  });

  it('flags chmod 777', () => {
    expect(isDestructive('chmod 777 file.sh')).toBe(true);
    expect(isDestructive('chmod -R 777 /var/www')).toBe(true);
  });

  it('flags chown -R', () => {
    expect(isDestructive('chown -R user:group /')).toBe(true);
  });

  it('flags /dev/null redirects', () => {
    expect(isDestructive('cat /dev/null > important.log')).toBe(true);
  });

  it('flags mkfs', () => {
    expect(isDestructive('mkfs.ext4 /dev/sda1')).toBe(true);
  });

  it('flags shutdown and reboot', () => {
    expect(isDestructive('shutdown -h now')).toBe(true);
    expect(isDestructive('reboot')).toBe(true);
  });

  it('flags kill -9', () => {
    expect(isDestructive('kill -9 1234')).toBe(true);
  });

  it('flags docker rm -f', () => {
    expect(isDestructive('docker rm -f mycontainer')).toBe(true);
  });

  it('flags docker system prune', () => {
    expect(isDestructive('docker system prune -a')).toBe(true);
  });

  it('flags kubectl delete', () => {
    expect(isDestructive('kubectl delete pod my-pod')).toBe(true);
  });

  it('flags npm unpublish', () => {
    expect(isDestructive('npm unpublish my-package')).toBe(true);
  });

  it('flags TRUNCATE TABLE', () => {
    expect(isDestructive('TRUNCATE TABLE logs')).toBe(true);
    expect(isDestructive('TRUNCATE logs')).toBe(true);
  });

  it('flags ALTER TABLE DROP', () => {
    expect(isDestructive('ALTER TABLE users DROP COLUMN email')).toBe(true);
  });

  it('allows safe commands', () => {
    expect(isDestructive('ls -la')).toBe(false);
    expect(isDestructive('git status')).toBe(false);
    expect(isDestructive('npm test')).toBe(false);
    expect(isDestructive('echo hello')).toBe(false);
    expect(isDestructive('cat file.txt')).toBe(false);
  });
});

describe('requiresConfirmation', () => {
  it('never confirms read-only tools', () => {
    expect(requiresConfirmation('nexus_file_read', { path: 'foo.ts' })).toBe(false);
    expect(requiresConfirmation('nexus_file_open', { path: 'foo.ts' })).toBe(false);
    expect(requiresConfirmation('nexus_file_close', { path: 'foo.ts' })).toBe(false);
    expect(requiresConfirmation('nexus_git_status', {})).toBe(false);
    expect(requiresConfirmation('nexus_git_diff', {})).toBe(false);
    expect(requiresConfirmation('nexus_git_log', {})).toBe(false);
    expect(requiresConfirmation('nexus_git_branch_list', {})).toBe(false);
    expect(requiresConfirmation('nexus_editor_focus', { path: 'foo.ts' })).toBe(false);
    expect(requiresConfirmation('nexus_editor_goto_line', { path: 'foo.ts', line: 1 })).toBe(false);
  });

  it('always confirms write tools', () => {
    expect(requiresConfirmation('nexus_file_write', { path: 'foo.ts', content: 'x' })).toBe(true);
    expect(requiresConfirmation('nexus_terminal_run', { command: 'echo hi' })).toBe(true);
    expect(requiresConfirmation('nexus_git_push', {})).toBe(true);
    expect(requiresConfirmation('nexus_git_commit', { message: 'fix' })).toBe(true);
    expect(requiresConfirmation('nexus_editor_insert', { path: 'foo.ts', text: 'x', line: 1 })).toBe(true);
    expect(requiresConfirmation('nexus_editor_replace_selection', { path: 'foo.ts', oldText: 'a', newText: 'b' })).toBe(true);
  });

  it('confirms git mutation tools', () => {
    expect(requiresConfirmation('nexus_git_add', { paths: ['.'] })).toBe(true);
    expect(requiresConfirmation('nexus_git_pull', {})).toBe(true);
    expect(requiresConfirmation('nexus_git_branch_create', { name: 'feat' })).toBe(true);
    expect(requiresConfirmation('nexus_git_branch_switch', { name: 'feat' })).toBe(true);
  });

  it('supports bare tool names', () => {
    expect(requiresConfirmation('file_read', { path: 'foo.ts' })).toBe(false);
    expect(requiresConfirmation('file_write', { path: 'foo.ts', content: 'x' })).toBe(true);
    expect(requiresConfirmation('git_push', {})).toBe(true);
  });
});

describe('confirmationReason', () => {
  it('returns reason for write tools', () => {
    const reason = confirmationReason('nexus_file_write', { path: 'src/main.ts' });
    expect(reason).toContain('src/main.ts');
  });

  it('returns reason for terminal run', () => {
    const reason = confirmationReason('nexus_terminal_run', { command: 'npm test' });
    expect(reason).toContain('npm test');
  });

  it('returns destructive reason for destructive commands', () => {
    const reason = confirmationReason('nexus_terminal_run', { command: 'rm -rf /tmp' });
    expect(reason).toContain('destructive');
  });
});
