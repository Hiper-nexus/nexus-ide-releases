export interface ReleaseNote {
  title: string;
  detail: string;
}

export interface AppRelease {
  version: string;
  date: string;
  codename: string;
  summary: string;
  highlights: ReleaseNote[];
  fixes: ReleaseNote[];
}

export const CURRENT_RELEASE: AppRelease = {
  version: '0.13.3',
  date: '2026-07-11',
  codename: 'Design Systems Shipping',
  summary:
    'Design systems completos (settings + MCP + DESIGN.md), packaging Linux com ssh2 externalizado, e caminho de release macOS via keychain notary local.',
  highlights: [
    {
      title: 'Design systems no produto',
      detail:
        'Catálogo designmd.ai nas definições, import como ContextDraft, DESIGN.md no prompt de design mode e facts no ingest de contexto.',
    },
    {
      title: 'SSH e Linux packaging',
      detail:
        'ssh2 opcional e fora do bundle Vite; build Linux deixa de falhar em nativos cpu-features/sshcrypto.',
    },
    {
      title: 'Mission Rail e multi-missão',
      detail:
        'Activity Rail, multi-missão segura e integrações forge/Linear permanecem nesta linha.',
    },
  ],
  fixes: [
    {
      title: 'Package Linux desbloqueado',
      detail:
        'Nativos do ssh2 não entram no grafo de bundling do processo main.',
    },
  ],
};
