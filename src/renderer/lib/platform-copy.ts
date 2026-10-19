/**
 * F-1579: textos de interface que mudam com o sistema operacional. O cliente
 * de Windows lia "Salva no Keychain", "detecção local no Mac" e "arraste do
 * Finder" — nomes de coisas que o Windows não tem. Componente novo lê
 * `platformCopy()`; não escreva ternário de plataforma no texto.
 *
 * O cofre de chaves é o `safeStorage` do Electron cifrando
 * `~/.nexus/secrets.enc` (`src/main/persistence/secrets-store.ts`): Keychain
 * no macOS, DPAPI no Windows, libsecret no Linux.
 *
 * Os campos de meio de frase são todos masculinos, para caberem depois de
 * "no", "do", "pelo" e "neste" sem concordância por plataforma.
 */
import { uiPlatform, type UiPlatform } from './platform';

export interface PlatformCopy {
  /** Cofre do sistema no meio da frase: "salva no …", "cifrada pelo …". */
  readonly vault: string;
  /** O mesmo cofre no começo da frase. */
  readonly vaultTitle: string;
  /** Chip curto do armazenamento seguro. */
  readonly vaultChip: string;
  /** Dica (tooltip): o mecanismo que cifra o cofre. */
  readonly vaultDetail: string;
  /** Armadilha conhecida do cofre neste sistema; null quando não há. */
  readonly vaultCaution: string | null;
  /** Gerenciador de arquivos no meio da frase: "arraste do …". */
  readonly fileManager: string;
  /** Rótulo da ação que mostra um arquivo salvo na pasta dele. */
  readonly revealInFileManager: string;
  /** O Main sabe abrir as telas de privacidade do microfone e de som. */
  readonly canOpenSoundSettings: boolean;
  /** Só o macOS tem o reset guiado da permissão do microfone (tccutil). */
  readonly canResetMicPermission: boolean;
  /** Microfone liberado que entrega silêncio absoluto. */
  readonly phantomMicNotice: string;
  /** Aviso sobre o caminho do conector Arms; null quando ele é estável. */
  readonly armsPathCaution: string | null;
}

const COPY: Readonly<Record<UiPlatform, PlatformCopy>> = {
  mac: {
    vault: 'Keychain',
    vaultTitle: 'Keychain',
    vaultChip: 'Keychain seguro',
    vaultDetail: 'Keychain do macOS',
    vaultCaution: 'Nunca clique “Reajustar Para Padrões” no diálogo do macOS.',
    fileManager: 'Finder',
    revealInFileManager: 'Mostrar no Finder',
    canOpenSoundSettings: true,
    canResetMicPermission: true,
    phantomMicNotice: 'Permissão de mic fantasma — o macOS diz OK mas entrega silêncio.',
    armsPathCaution: null,
  },
  windows: {
    vault: 'cofre do Windows',
    vaultTitle: 'Cofre do Windows',
    vaultChip: 'Cofre do Windows',
    vaultDetail: 'cofre do Windows (DPAPI, ligado à sua conta de usuário)',
    vaultCaution: null,
    fileManager: 'Explorador de Arquivos',
    revealInFileManager: 'Mostrar no Explorador de Arquivos',
    canOpenSoundSettings: true,
    canResetMicPermission: false,
    phantomMicNotice:
      'O Windows diz que o mic está liberado, mas entrega silêncio — confira o acesso ao microfone nos Ajustes.',
    armsPathCaution:
      'No Windows a pasta do Nexus muda a cada atualização: copie este trecho de novo depois de atualizar.',
  },
  linux: {
    vault: 'chaveiro do sistema',
    vaultTitle: 'Chaveiro do sistema',
    vaultChip: 'Chaveiro do sistema',
    vaultDetail: 'chaveiro do sistema (libsecret)',
    vaultCaution: null,
    fileManager: 'gerenciador de arquivos',
    revealInFileManager: 'Mostrar na pasta',
    canOpenSoundSettings: false,
    canResetMicPermission: false,
    phantomMicNotice:
      'O sistema diz que o mic está liberado, mas entrega silêncio — confira a entrada e o volume no mixer de som.',
    armsPathCaution: null,
  },
};

export function platformCopy(platform: UiPlatform = uiPlatform()): PlatformCopy {
  return COPY[platform];
}
