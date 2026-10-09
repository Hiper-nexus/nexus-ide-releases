# Handoff — roteiro proposto de validação Windows/WSL

- Origem: sessão macOS, sem execução real de WSL.
- Destino: máquina Windows com WSL2 instalado.
- Referência: [PR #126](https://github.com/Hiper-nexus/nexus-ide/pull/126).
- Fonte a validar: registre o SHA exato do candidato integrado. Não use “o mais novo da branch” como identidade da evidência.

## Estado demonstrado e trabalho restante

`planWslRuntime` monta argv, valida caminhos e devolve um rótulo de slot de credencial. Ele não executa `wsl.exe` e não é chamado por um consumidor produtivo de PTY/runtime. Rótulos `wsl:Ubuntu` e `wsl:Debian` diferentes não provam isolamento de sessões nativas de credenciais. O plano serializa `env` em exports Bash validados; isso não demonstra aplicação dessas variáveis a um processo real.

CdpRelay, sua fábrica de navegador e o editor Tiptap são módulos/adaptadores que exigem consumidores e validação própria. Seus testes de contrato não provam endpoint CDP autenticado, UI de editor publicada nem backend WSL completo. Este documento não atribui “42/42” ou outro total antigo ao candidato atual.

Os passos abaixo são um roteiro externo proposto. Registre resultados e artefatos do Windows separadamente das suítes executadas no macOS.

## Preparação

| Item | Preparação |
|---|---|
| Sistema | Windows 10/11 com WSL2 |
| Distribuições | Ubuntu e Debian, ou duas outras instaladas; registrar nomes exatos |
| Fonte | Checkout limpo do SHA do candidato integrado |
| Node | Node 22 compatível com engines do repositório; registrar versão exata |
| Dependências | npm fixado do repositório; `npm ci` e `npm run rebuild:node` nesse checkout |

## A. Contratos puros

```powershell
npx vitest run src/main/remote/wsl-runtime.test.ts src/main/remote/wsl-detect.test.ts --maxWorkers=2
```

Registre a contagem efetiva e o exit code. Esses testes verificam planejamento/validação; não iniciam uma distro nem certificam PTY ou credenciais.

O argv atual usa `-d <distro> --cd <linuxCwd> --exec bash -lc <comando>`. A forma antiga `-- exec bash -lc` não corresponde ao planejador.

Os helpers de caminho ficam em `src/shared/wsl-paths.ts`. Reexecute seus testes existentes quando houver mudança nesses helpers; não use um REPL que pressupõe suporte automático a require de arquivos TypeScript.

## B. Comandos reais de WSL

```powershell
wsl.exe -l -q
wsl.exe -d Ubuntu --cd /home --exec bash -lc "pwd && uname -a"
wsl.exe -d Debian --cd /home --exec bash -lc "pwd && uname -a"
wsl.exe -d Ubuntu --exec bash -lc "ls /mnt/c"
```

Registrar nomes de distro, cwd, saída, versão de WSL e exit codes. Substitua Ubuntu/Debian pelos nomes realmente instalados. Verifique caminhos Windows/UNC e recusa de uma UNC de outra distro pelo plano no mesmo SHA.

A diferença entre slots é apenas um contrato de nome. Uma prova de credencial exige, depois da integração do consumidor, autenticação nativa independente, stores reais usados por cada processo, renovação e ausência de troca entre contas/distros.

## C. Integração a validar quando houver consumidor

Estes passos não podem ser declarados concluídos apenas pelo planejador atual:

- PTY do Electron/Node abrindo a distro e usando o cwd planejado.
- Configuração de runtime/distro na UI ligada a esse consumidor.
- Aplicação das variáveis de ambiente e do store de credenciais correto, com prova de renovação/isolamento.
- Cancelamento, saída física do processo e recuperação de sessão.
- `host.wsl.isAvailable` / `host.wsl.listDistros` contra o WSL real e, separadamente, sua ligação ao novo plano. Um contrato RPC existente não comprova o caminho completo.

Registrar “não integrado” quando o caminho não existe, em vez de procurar uma opção de UI que este PR não fornece.

## Registro de evidência

| Prova | SHA, ambiente, resultado e artefato |
|---|---|
| Suítes de contrato WSL | |
| Lista real de distros | |
| Execução/cwd em duas distros | |
| Caminhos Windows/UNC e recusa de distro divergente | |
| PTY e ligação do consumidor | não integrado até prova |
| Credenciais nativas/renovação/isolamento | não verificado até prova |
| RPC real e ligação ao plano | |

Falha de ABI de better-sqlite3 exige reconstrução para o Node/Electron usado no checkout de teste; não é evidência de uma regressão do planejador. Nomes de distro recusados pelo contrato devem ser registrados com a entrada e a recusa concreta, sem inferir que toda diferença de nome é erro ou sucesso.

## Arquivos de referência

| Responsabilidade | Arquivo |
|---|---|
| Plano de argv/caminho e rótulo de slot | `src/main/remote/wsl-runtime.ts` |
| Helpers Windows/UNC | `src/shared/wsl-paths.ts` |
| Detecção por ambiente | `src/main/remote/wsl-detect.ts` |
| Contratos puros | `src/main/remote/wsl-runtime.test.ts`, `src/main/remote/wsl-detect.test.ts` |

Este roteiro não contém prova Windows executada e não declara prontidão de publicação.
