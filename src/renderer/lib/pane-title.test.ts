import { describe, expect, it } from 'vitest';
import {
  cliPaneDisplayTitle,
  isWindowsConsoleHostTitle,
  normalizePaneTitle,
  windowsConsoleHostName,
} from './pane-title';

describe('normalizePaneTitle', () => {
  it.each([
    ['⠋ nexus-ide', 'nexus-ide', 'busy'],
    ['⠙ nexus-ide', 'nexus-ide', 'busy'],
    ['⠹ Brief…', 'Brief…', 'busy'],
    ['⠸ Brief…', 'Brief…', 'busy'],
    ['⠼ Brief…', 'Brief…', 'busy'],
    ['⠴ Brief…', 'Brief…', 'busy'],
    ['⠦ Brief…', 'Brief…', 'busy'],
    ['⠧ Brief…', 'Brief…', 'busy'],
    ['⠇ Brief…', 'Brief…', 'busy'],
    ['⠏ Brief…', 'Brief…', 'busy'],
    ['⠿ workspace', 'workspace', 'busy'],
    ['◐ Brief…', 'Brief…', 'busy'],
    ['◑ Brief…', 'Brief…', 'busy'],
    ['◒ Brief…', 'Brief…', 'busy'],
    ['◓ Brief…', 'Brief…', 'busy'],
    ['✳ Pondering…', 'Pondering…', 'busy'],
    ['✻ Pondering…', 'Pondering…', 'busy'],
    ['✽ Pondering…', 'Pondering…', 'busy'],
    ['✶ Pondering…', 'Pondering…', 'busy'],
    ['✢ Pondering…', 'Pondering…', 'busy'],
    ['· nexus-ide', 'nexus-ide', 'idle'],
  ] as const)('normaliza %j -> título %j, atividade %j', (raw, title, activity) => {
    expect(normalizePaneTitle(raw)).toEqual({ title, activity });
  });

  it('não mexe em títulos sem glifo de status inicial', () => {
    expect(normalizePaneTitle('nexus-ide')).toEqual({ title: 'nexus-ide', activity: null });
    expect(normalizePaneTitle('zsh')).toEqual({ title: 'zsh', activity: null });
  });

  it('só reconhece o glifo quando está na frente — não confunde com o texto', () => {
    expect(normalizePaneTitle('nexus-ide ⠋')).toEqual({
      title: 'nexus-ide ⠋',
      activity: null,
    });
  });

  it('colapsa espaços internos repetidos', () => {
    expect(normalizePaneTitle('  nexus-ide   worktree  ')).toEqual({
      title: 'nexus-ide worktree',
      activity: null,
    });
  });

  it('colapsa o espaço entre o glifo e o texto', () => {
    expect(normalizePaneTitle('⠋   nexus-ide')).toEqual({
      title: 'nexus-ide',
      activity: 'busy',
    });
  });

  it('retorna título vazio para string vazia ou só espaços', () => {
    expect(normalizePaneTitle('')).toEqual({ title: '', activity: null });
    expect(normalizePaneTitle('   ')).toEqual({ title: '', activity: null });
  });

  it('retorna título vazio quando a mensagem é só o glifo', () => {
    expect(normalizePaneTitle('⠋')).toEqual({ title: '', activity: 'busy' });
    expect(normalizePaneTitle('·')).toEqual({ title: '', activity: 'idle' });
  });

  it('trata o * ASCII do Claude Code como glifo de atividade, não como o nome do pane', () => {
    expect(normalizePaneTitle('* Codex pane boot crash')).toEqual({
      title: 'Codex pane boot crash',
      activity: 'busy',
    });
  });
});

describe('cliPaneDisplayTitle — F-597 identidade da CLI no cabeçalho', () => {
  it('prefixa a família do adapter quando o OSC/título fala de outro CLI', () => {
    const { title } = normalizePaneTitle('* Codex pane boot crash');
    expect(cliPaneDisplayTitle('claude', title)).toBe(
      'Claude · Codex pane boot crash',
    );
  });

  it('não duplica o prefixo quando o título já começa com a família', () => {
    expect(cliPaneDisplayTitle('claude', 'Claude · supabase MCP')).toBe(
      'Claude · supabase MCP',
    );
    expect(cliPaneDisplayTitle('codex', 'GPT-5.6 review')).toBe('GPT-5.6 review');
  });

  it('sem adapterId (shell) devolve o título cru', () => {
    expect(cliPaneDisplayTitle(undefined, 'zsh')).toBe('zsh');
  });

  it('título vazio cai na família sozinha', () => {
    expect(cliPaneDisplayTitle('grok', '')).toBe('Grok');
    expect(cliPaneDisplayTitle('codex', '   ')).toBe('GPT');
  });
});

describe('isWindowsConsoleHostTitle — OSC automático do ConPTY', () => {
  it.each([
    String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`,
    String.raw`C:\WINDOWS\system32\cmd.exe - agy.cmd`,
    String.raw`Administrador: C:\Windows\System32\cmd.exe`,
    String.raw`Administrator: C:\Program Files\PowerShell\7\pwsh.exe`,
    String.raw`c:/windows/system32/cmd.exe`,
    String.raw`\\?\C:\Windows\System32\cmd.exe`,
    String.raw`C:\tools\agy.cmd`,
    String.raw`C:\tools\run.bat - build`,
    String.raw`C:\tools\boot.ps1`,
    String.raw`C:\tools\edit.com`,
    'Windows PowerShell',
    'Administrator: Windows PowerShell',
    'Prompt de Comando',
    'Command Prompt',
  ])('reconhece %j', (title) => {
    expect(isWindowsConsoleHostTitle(title)).toBe(true);
  });

  it.each([
    'nexus-ide',
    'zsh',
    'Fix Codex pane',
    '⠋ Running command…',
    String.raw`C:\Users\me\project`,
    String.raw`C:\Users\me\notes.txt`,
    String.raw`C:\repo\build.exe falhou na CI`,
    '/usr/bin/zsh',
    'node.exe',
    '',
  ])('deixa passar %j', (title) => {
    expect(isWindowsConsoleHostTitle(title)).toBe(false);
  });

  it('windowsConsoleHostName devolve só o executável, sem pasta nem extensão', () => {
    expect(
      windowsConsoleHostName(
        String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`,
      ),
    ).toBe('powershell');
    expect(windowsConsoleHostName(String.raw`C:\WINDOWS\system32\cmd.exe - agy.cmd`)).toBe('cmd');
    expect(windowsConsoleHostName(String.raw`Administrador: C:\Windows\System32\cmd.exe`)).toBe('cmd');
    expect(windowsConsoleHostName('Command Prompt')).toBe('Command Prompt');
    expect(windowsConsoleHostName('nexus-ide')).toBeNull();
  });
});

describe('cliPaneDisplayTitle — título do console host nunca vira cabeçalho', () => {
  it('descarta o caminho do console host e devolve só a família', () => {
    expect(
      cliPaneDisplayTitle('agy', String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`),
    ).toBe('AGY');
    expect(cliPaneDisplayTitle('agy', String.raw`C:\WINDOWS\system32\cmd.exe - agy.cmd`)).toBe('AGY');
    expect(cliPaneDisplayTitle('agy', String.raw`Administrador: C:\Windows\System32\cmd.exe`)).toBe('AGY');
  });

  it('limpa título já gravado no layout ("AGY · C:\\Windows\\…")', () => {
    expect(
      cliPaneDisplayTitle('agy', String.raw`AGY · C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`),
    ).toBe('AGY');
    expect(cliPaneDisplayTitle('agy', 'AGY · Windows PowerShell')).toBe('AGY');
  });

  it('preserva títulos legítimos de tarefa', () => {
    expect(cliPaneDisplayTitle('agy', 'Fix terminal spinner')).toBe('AGY · Fix terminal spinner');
    expect(cliPaneDisplayTitle('agy', 'AGY · Fix terminal spinner')).toBe('AGY · Fix terminal spinner');
    expect(cliPaneDisplayTitle('agy', String.raw`C:\Users\me\project`)).toBe(
      String.raw`AGY · C:\Users\me\project`,
    );
  });

  it('sem família (shell) não inventa nada: devolve o texto cru', () => {
    expect(cliPaneDisplayTitle(undefined, 'zsh')).toBe('zsh');
  });
});
