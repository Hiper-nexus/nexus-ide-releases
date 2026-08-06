import { describe, expect, it, vi } from 'vitest';
import { planDestructiveReversibility } from './destructive-reversibility';
import {
  prepareDestructiveReversibility,
  type ReversibilityIo,
} from './destructive-reversibility-io';

function fakeIo(overrides: Partial<ReversibilityIo> = {}): ReversibilityIo {
  return {
    trash: vi.fn(async () => {}),
    exists: vi.fn(async () => true),
    revParse: vi.fn(async () => 'a'.repeat(40)),
    updateRef: vi.fn(async () => {}),
    resolvePath: (cwd, target) =>
      target.startsWith('/') ? target : `${cwd}/${target}`,
    ...overrides,
  };
}

const CWD = '/repo';
const NOW = 1_754_000_000_000;

async function prepare(command: string, io: ReversibilityIo) {
  return prepareDestructiveReversibility(planDestructiveReversibility(command), {
    cwd: CWD,
    io,
    now: NOW,
  });
}

describe('preparo de reversibilidade destrutiva', () => {
  it('rm -rf simples vai para a lixeira antes de rodar', async () => {
    const io = fakeIo();
    const receipt = await prepare('rm -rf build/cache', io);

    expect(io.trash).toHaveBeenCalledWith('/repo/build/cache');
    expect(receipt.reversible).toBe(true);
    expect(receipt.revertPath).toContain('Lixeira');
  });

  it('lixeira que falha propaga — não se remove pergunta em cima de desfazer quebrado', async () => {
    const io = fakeIo({
      trash: vi.fn(async () => {
        throw new Error('EPERM');
      }),
    });
    await expect(prepare('rm -rf build', io)).rejects.toThrow('EPERM');
  });

  it('force-push guarda o tip REMOTO, não o HEAD local', async () => {
    const revParse = vi.fn(async () => 'b'.repeat(40));
    const io = fakeIo({ revParse });
    const receipt = await prepare('git push --force origin main', io);

    expect(revParse).toHaveBeenCalledWith(CWD, '@{upstream}');
    expect(io.updateRef).toHaveBeenCalledWith(
      CWD,
      `refs/nexus-undo/remote-tip-${NOW}`,
      'b'.repeat(40),
    );
    expect(receipt.revertPath).toContain('git reset --hard refs/nexus-undo/');
  });

  it('reset --hard guarda o HEAD anterior', async () => {
    const io = fakeIo();
    const receipt = await prepare('git reset --hard HEAD~1', io);

    expect(io.revParse).toHaveBeenCalledWith(CWD, 'HEAD');
    expect(receipt.reversible).toBe(true);
  });

  it('sem upstream degrada para registro, nunca para pergunta', async () => {
    const io = fakeIo({ revParse: vi.fn(async () => null) });
    const receipt = await prepare('git push --force origin nova-branch', io);

    expect(io.updateRef).not.toHaveBeenCalled();
    expect(receipt.reversible).toBe(true);
    expect(receipt.revertPath).toContain('nada anterior a perder');
  });

  it('irreversível é declarado, com o motivo legível', async () => {
    const io = fakeIo();
    const receipt = await prepare('mkfs.ext4 /dev/sda1', io);

    expect(receipt.reversible).toBe(false);
    expect(receipt.revertPath).toContain('Sem desfazer');
  });

  it('comando inofensivo não toca em IO nenhum', async () => {
    const io = fakeIo();
    const receipt = await prepare('npm test', io);

    expect(io.trash).not.toHaveBeenCalled();
    expect(io.revParse).not.toHaveBeenCalled();
    expect(receipt.revertPath).toBe('');
  });

  it('rm composto não vira lixeira — seria engolir o resto da linha', async () => {
    const io = fakeIo();
    const receipt = await prepare('rm -rf build && npm install', io);

    expect(io.trash).not.toHaveBeenCalled();
    expect(receipt.reversible).toBe(false);
  });
});

/**
 * Os dois defeitos que a revisão final pegou POR EXECUÇÃO, não por leitura.
 * Ambos vieram de supor o comportamento de `shell.trashItem`; medido em Electron
 * real, ele REJEITA caminho ausente e rejeita glob.
 */
describe('regressões da revisão final', () => {
  it('rm -rf de caminho que não existe NÃO aborta — não havia nada a salvar', async () => {
    const trash = vi.fn(async () => {});
    const io = fakeIo({ trash, exists: vi.fn(async () => false) });

    const receipt = await prepare('rm -rf build', io);

    // Antes da correção isto rejeitava e derrubava o comando: uma limpeza
    // idempotente perfeitamente comum passava a falhar por invenção nossa.
    expect(trash).not.toHaveBeenCalled();
    expect(receipt.reversible).toBe(true);
    expect(receipt.revertPath).toContain('já não existiam');
  });

  it('só o que EXISTE vai para a lixeira, numa lista mista', async () => {
    const existentes = new Set(['/repo/tem']);
    const io = fakeIo({
      exists: vi.fn(async (p: string) => existentes.has(p)),
    });

    await prepare('rm -rf tem naotem', io);

    expect(io.trash).toHaveBeenCalledTimes(1);
    expect(io.trash).toHaveBeenCalledWith('/repo/tem');
  });

  it('lixeira que falha em caminho EXISTENTE ainda aborta — é o caso que importa', async () => {
    const io = fakeIo({
      exists: vi.fn(async () => true),
      trash: vi.fn(async () => {
        throw new Error('EPERM');
      }),
    });

    await expect(prepare('rm -rf build', io)).rejects.toThrow('EPERM');
  });

  it('glob não é reversível: sem expansão não há o que mandar para a lixeira', async () => {
    const io = fakeIo();
    const receipt = await prepare('rm -rf dist/*', io);

    expect(io.trash).not.toHaveBeenCalled();
    // reversible:false é o que faz o piso de confirmação PERMANECER para ele.
    expect(receipt.reversible).toBe(false);
    expect(receipt.revertPath).toContain('glob');
  });
});
