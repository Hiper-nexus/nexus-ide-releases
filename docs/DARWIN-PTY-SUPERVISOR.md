# Supervisor nativo de sessões PTY no macOS

O NexusIDE executa cada comando aberto por `node-pty` no macOS sob duas
fronteiras autenticadas. O estágio zero é o `/usr/bin/perl` da Apple, protegido
por SIP, com fonte inline em `argv` e taint mode (`-T`); ele trace-executa e
valida a imagem viva do `nexus-pty-supervisor`, um helper universal assinado. O
bootstrap do helper usa `POSIX_SPAWN_SETEXEC` junto de
`responsibility_spawnattrs_setdisclaim`: o mesmo PID que o PTY conhece é
reexecutado como processo responsável por si. O estágio zero valida também essa
segunda imagem viva do helper e só então desanexa o trace. Depois de confirmar
`responsible_pid == getpid()` e um `responsible_unique_id` não nulo, o helper
inicia o CLI real, que herda essa responsabilidade.

## Spawn autenticado do provider

Um CLI qualificado para autoridade autônoma no macOS não usa o modo genérico.
O Nexus passa ao helper um selo produzido antes do IPC:

```sh
nexus-pty-supervisor supervise-authenticated \
  --identifier codex \
  --team-id 2DC432GLL2 \
  --cdhash c9da028e2080a684d2c355e6f40ffc53c21ff7ee \
  -- /caminho/absoluto/para/o/Mach-O/vendor [args...]
```

Esse caminho recebe obrigatoriamente o **Mach-O nativo do fornecedor**, nunca
um wrapper JavaScript nem `/usr/bin/sandbox-exec`. Quando há Seatbelt, o
`sandbox-exec -p <perfil>` permanece como processo externo e lança o supervisor
como alvo interno; por herança, o supervisor e o provider ficam no mesmo
perfil.

O manifesto desta release é fechado para macOS `arm64` e autoriza exatamente:

- Codex `0.145.0`, CDHash
  `c9da028e2080a684d2c355e6f40ffc53c21ff7ee`;
- Claude Code `2.1.220`, CDHash
  `474c5a3154406ea5ee537b0a25f24f9292b1570b`.

Um Mach-O diferente assinado pelo mesmo Team ID não é uma raiz válida. Uma
arquitetura ou release sem CDHash no manifesto falha fechada. A consulta
`--version` é somente uma confirmação adicional de coerência: ela também passa
por `supervise-authenticated`, portanto o provider é trace-executado e validado
ao vivo no trap de `exec` antes de executar qualquer instrução da nova imagem. O
Nexus nunca executa diretamente o pathname do provider para descobrir sua
versão.

O supervisor cria o provider com `fork`, limpa handlers e máscara de sinais,
chama `PT_TRACE_ME` no filho e então `execve`. O kernel para a imagem substituta
em `SIGTRAP`, antes da primeira instrução em userspace. Esse stop pertence ao
tracer: ao contrário de `POSIX_SPAWN_START_SUSPENDED`, um processo do mesmo UID
não consegue liberar o provider enviando `SIGCONT`. Enquanto o provider está
nesse exec trap, o supervisor prova a responsabilidade herdada e obtém um
`SecCodeRef` vivo pelo PID. `SecCodeCheckValidity` exige simultaneamente:

- identificador exato;
- raiz `anchor apple generic`;
- cadeia **Developer ID Application** da Apple;
- Team ID exato no certificado;
- CDHash exato da arquitetura carregada.

O dicionário vivo de assinatura é então comparado de forma independente para
identificador, Team ID e os 20 bytes do CDHash. A documentação da própria
Security.framework garante que a validação dinâmica é segura contra troca da
origem no filesystem. O supervisor relê a responsabilidade depois da validação
e só então executa `PT_DETACH`, liberando a imagem exata.

Qualquer erro, troca de pathname, assinatura ad-hoc, Team ID divergente, CDHash
divergente, trap inesperado ou falha da Security.framework usa `PT_KILL`, coleta
o filho, prova a ausência de toda a coorte e retorna `76`. Nenhuma instrução da
imagem do provider é liberada nesse caminho de erro. O teste nativo troca o
arquivo depois de capturar o selo por outro Mach-O Developer ID no mesmo
pathname; o substituto teria escrita e loopback liberados, mas nem o construtor,
nem o arquivo-marcador, nem a conexão acontecem. Outro teste envia 5.000
`SIGCONT` externos durante o trap e comprova que a imagem divergente permanece
sem executar. Testes independentes matam com `SIGKILL` cada tracer durante seu
trap — Perl sobre o helper e helper sobre o provider — e comprovam que o kernel
mata também o tracee, sem construtor ou descendente residual.

Essa garantia fecha a troca entre o pathname recebido e a imagem de provider
efetivamente carregada. O estágio zero estende a mesma propriedade à imagem do
helper antes que ela execute: confere, via `csops` do kernel, validade,
identificador, Team ID e CDHash exatos tanto no primeiro `exec` quanto no
`POSIX_SPAWN_SETEXEC` de responsabilidade. A fronteira residual anterior ao
estágio zero está descrita abaixo.

Quando o CLI principal termina — inclusive se deixou um processo com
double-fork, `setsid` ou reparent para o `launchd` — o supervisor continua vivo.
Ele enumera processos com `libproc` e filtra pelo par **responsible PID +
responsible unique id**. Após uma graça de `SIGTERM`, envia `SIGSTOP` em
varreduras sucessivas até obter duas fotos completas do mesmo conjunto parado;
só então usa `proc_signal_with_audittoken` para `SIGKILL`. Cada identidade lê
`PROC_PIDUNIQIDENTIFIERINFO` duas vezes, e o kernel compara também o PID version
do audit token no momento do sinal. O helper exige duas varreduras completas e
separadas sem membros vivos, enquanto sua própria identidade-âncora continua
viva, antes de sair. Uma varredura incompleta mantém o supervisor vivo
(fail-closed).

O host PTY não aplica o escalonamento PPID legado ao helper no macOS, pois matar
a raiz destruiria a autoridade que produz a prova. Ele pede `SIGTERM` e trata
somente uma saída normal do helper como recibo. O código dessa saída preserva o
código do CLI e, portanto, pode ser diferente de zero; ele não é sozinho o
discriminador da prova. O estágio zero reserva `129..159` exclusivamente para
uma morte ambígua do helper e rejeita toda saída nessa faixa. Depois de provar a
ausência da coorte, o helper converte um código legítimo do provider que cairia
nessa faixa para o sentinela normal `125`. Um teardown solicitado e comprovado
retorna `0`; um timeout comprovado retorna `124`. O estágio zero nunca mata o
helper depois que o provider foi liberado: espera sem limite a autoridade
assinada concluir as duas varreduras de ausência. Se o helper sofrer
`SIGKILL`, crash ou qualquer término não normal antes disso, o resultado público
fica em `159` e falha fechado.

Injeções de processo em testes continuam explicitamente no caminho genérico.

## Inventário operacional

O modo abaixo produz um único JSON, próprio para automação:

```sh
resources/native/darwin/nexus-pty-supervisor inventory
resources/native/darwin/nexus-pty-supervisor \
  inventory --responsible-pid 1234 --responsible-unique-id 123456
```

Cada processo inclui `pid`, `ppid`, `pgid`, tempo de início, status, unique id
e PID version do processo, PID responsável e unique id responsável.
`complete:false` e saída não zero significam que a máquina não conseguiu provar
o inventário inteiro. O modo filtrado exige a âncora responsável ainda viva.

## Build e assinatura

`npm run build:darwin-pty-supervisor` compila `arm64` e `x86_64`, cria um
Mach-O universal e aplica assinatura ad-hoc obrigatória para desenvolvimento.
O binário liga explicitamente `CoreFoundation.framework` e
`Security.framework`; a ausência dessas APIs falha antes de qualquer spawn
autenticado.

Os hooks `postinstall`, `prestart`, `prestart:forge`, `prepackage` e `premake`
aplicam primeiro o patch fixado do `node-pty`; os hooks de execução/build também
regeneram o helper. No pacote de distribuição, o Forge inclui o binário como
`extraResource` e a assinatura final do app deve substituir a assinatura ad-hoc
pela identidade Developer ID.

O runtime empacotado aceita o helper **somente** em
`process.resourcesPath/nexus-pty-supervisor`; não consulta o diretório corrente
nem caminhos de desenvolvimento. Antes do spawn ele rejeita symlink, exige que
o `realpath` continue dentro de `NexusIDE.app/Contents/Resources`, verifica o
helper e o selo completo do `.app` com `codesign --strict`, confere os
identificadores designados `nexus-pty-supervisor` e `com.nexuside.app` e exige
Team ID `35P5XL3JN6` nos dois. Pacotes ad-hoc são recusados: servem para
verificação de build, não para executar CLIs em modo empacotado. A identidade do
arquivo é relida após essas verificações para detectar substituição durante a
validação. O processo vivo que autoriza o spawn precisa coincidir com o
executável principal selado ou com o `NexusIDE Helper.app` exato. No segundo
caso, seu pai vivo também precisa coincidir com o executável principal do mesmo
bundle. Identificador, Team ID e CDHash são comparados em todos esses vínculos.
Quando o provider fica sob o Seatbelt externo do Codex, o perfil concede leitura
somente ao `.app` assinado que contém os executáveis Main/Helper usados nessa
comparação. A raiz do bundle é necessária porque `SecStaticCodeCreateWithPath`
e `SecStaticCodeCheckValidity` também consultam metadados e recursos selados da
assinatura; liberar apenas os Mach-O falha fechado. O grant continua
somente-leitura e cobre código imutável do próprio produto, sem relaxar
identifier, Team, CDHash ou o vínculo de pai vivo.
Os caminhos fixos do repositório existem apenas no modo de desenvolvimento
explicitamente separado.

O smoke local do pacote tem uma exceção ainda mais estreita. O sentinel
posicional capturado pelo Main cria o perfil `packaged-smoke`, que viaja no
spec Main→utility junto de um selo ad-hoc do helper do próprio bundle. Esse
perfil aceita somente uma cadeia integralmente ad-hoc (app, utility e helper);
cadeias mistas são rejeitadas. O modo nativo `supervise-local-smoke` exige que o
provider seja o próprio helper, no caminho fixo de `Contents/Resources`, e que
o único argumento seja `provider-probe`. Mesmo nesse caso, a imagem viva é
trace-executada e validada por identificador + CDHash antes de emitir o recibo.
Sem o perfil, ou para qualquer CLI/comando diferente, o pacote ad-hoc continua
falhando fechado. Releases Developer ID usam exclusivamente a política
Team-signed normal, mesmo quando executam o smoke.

Antes de montar qualquer comando, o runtime valida que `/usr/bin/perl` e
`/usr/bin` são caminhos reais exatos, root-owned e não graváveis por grupo ou
outros. `codesign --strict` precisa identificar o Perl como
`com.apple.perl`, código de plataforma Apple e requisito designado ancorado na
Apple. O estágio zero remove variáveis de injeção de Perl e shell, usa
`PATH=/usr/bin:/bin` até autenticar o helper e restaura o `PATH` original apenas
dentro do helper antes do provider. Timeout, `SIGTERM` ou erro inesperado
encerram e coletam o helper traceado antes da saída do estágio zero.

## Cadeia do `@lydell/node-pty`

No macOS, o script `patch-node-pty-darwin.mjs` aceita somente o pacote
`@lydell/node-pty` 1.2.0-beta.12 e os hashes fixados de `unixTerminal.js`.
Ele troca o `helperPath` por `/usr/bin/perl`, valida o hash exato do resultado e
remove o `spawn-helper` da plataforma. Fonte, versão ou cópia inesperada falham
fechado. Smoke e verificação de release exigem **zero** entradas chamadas
`spawn-helper` no app.

O ABI nativo monta `argv` como `helperPath, cwd, file, ...args`. O PTY Host passa
`cwd=-T`, `file=-e` e a fonte do bootstrap em `argv`, produzindo diretamente
`/usr/bin/perl -T -e <bootstrap> -- <cwd-real> <plano-main-owned> ...`.
O bootstrap remove controles de startup do Perl, desmarca por captura regex o
TTY/cwd/comando/argv, abre `ttyname(0)` com `O_RDWR`, faz `chdir` e usa
`exec { $command } ...` com caminho absoluto, sem shell e sem resolução por
`PATH`. Só então começa o plano já montado pelo Main.

A fonte do estágio zero também viaja diretamente em `argv` e não carrega arquivo
do Nexus antes de `PT_TRACE_ME`. O Perl autentica as duas imagens do supervisor;
o supervisor autenticado cria e valida a imagem viva do provider. Assim não há
mais executável mutável do bundle antes da primeira barreira root/SIP-owned.

## Threat model e limites aceitos da API privada

`responsibility_spawnattrs_setdisclaim` e as consultas
`responsibility_get_*_responsible_for_pid` não são API pública da Apple. Elas
podem mudar ou desaparecer entre versões do macOS e não são adequadas à Mac App
Store. O Nexus resolve os símbolos com `dlsym` e **recusa iniciar o CLI** quando
eles, a assinatura do helper ou a identidade self-responsible não puderem ser
comprovados. Não há fallback para árvore PPID/PGID no macOS: esses vínculos não
capturam com segurança processos daemonizados.

Process responsibility também não é uma sandbox contra código hostil. Um
descendente especialmente construído e assinado pode tentar usar a mesma API
privada para abdicar da responsabilidade. O controle aqui garante ciclo de vida
para CLIs cooperativas e seus descendentes; confinamento de escrita, credenciais
e ferramentas continua sendo responsabilidade das políticas de spawn do Nexus.

O teardown enumera `PROC_RUID_ONLY`: processos filhos sem privilégio preservam o
real UID mesmo quando alteram effective UID. Executar um binário setuid capaz de
trocar o **real** UID fica fora do modelo de ameaça; o Nexus não concede essa
elevação. Processos protegidos anteriores à âncora são excluídos apenas quando
duas leituras do unique id monotônico provam que nasceram antes do supervisor.


## Jobs Main-owned de comandos pesados (C6)

`supervisedJobCommand(runtime, file, args)` usa o mesmo Perl SIP-owned e o selo
vivo do helper, com modo nativo `supervise-job`. É um contrato separado do PTY:
a saída normal do shell inicial conserva a âncora enquanto houver descendentes
vivos na coorte de responsabilidade, inclusive double-fork, setsid e reparent
para PID 1. Duas varreduras completas vazias sob a âncora viva liberam o recibo
normal, preservando o código do shell. `TERM` continua passando pelo fixed point,
sinais por audit token e prova de ausência existentes.

O keeper também mede a identidade do dono real (PID, process unique id e PID
version) pela cadeia de pai: Perl Apple → seu pai Main, ou pai direto nos testes
de desenvolvimento. Não recebe PID do dono por argv/env. Morte, reutilização ou
identidade não verificável do dono força teardown da própria coorte; depois da
prova retorna 74, não sucesso sintético. Perfis `packaged-smoke` e plataformas
sem o helper são recusados pelo builder de job.

Prova local: fixtures reais mantêm daemon destacado vivo após o shell sair,
confirmam recibo somente após término natural, provam TERM contra daemon que
ignora TERM e confirmam limpeza depois de SIGKILL do dono através do estágio
Perl. A integração MCP e a prova no candidato assinado pertencem ao coordenador.

## Native heavy jobs (F-875)

`nestedHeavyJobBaseCommand` is a Main-owned Apple stage-zero prefix for `heavy-job <kind> -- <absolute-target> [args...]`. The CLI's original sandbox, cwd, env and stdio remain inherited. The exact canonical outer supervisor authorizes the nested bootstrap; the general one-shot Main launch authorization remains unchanged.

Authority A establishes the responsibility anchor and a protected process group. Execution helper B is forked from A's already authenticated image, uses the original caller PG, and requests Main admission before target birth. B and every target/descendant inherit A's responsibility identity. A watches its exact stage-zero Perl owner P: P/normal caller PG death triggers cohort teardown. B SIGKILL cannot destroy A or orphan unobserved setsid descendants; A performs the existing fixed-point/audit-token cleanup and two complete empty scans.

The utility Host launches its observer through the Apple stage-zero barrier. Before READY/grant, it validates the live image and mode of A/B, registers kqueue NOTE_EXIT/NOTE_EXITSTATUS on A, and fences uniqueID/idversion on both sides. Normal A exit is the canonical whole-cohort receipt. Borrow uses A's exact kernel responsibility identity. Caller/Node/Perl exit and sampled PID absence never prove the job gone.

The private Main stop operation writes to the observer's control channel. The observer revalidates A's uniqueID, idversion and live seal, sends only audit-token-fenced TERM, and waits for the canonical receipt. It never PGKILLs A or signals a replacement PID. If A itself dies by signal, observer loss or NOTE_EXEC, state remains unknown and stop/drain reject explicitly; the reservation is preserved rather than fabricating a successful quit receipt. An outer PTY receipt cannot prove a separately disclaimed job.

`nativeHeavyJobEnvironment()` must be awaited after `setPtyHost` and before spawns mount. Cold codesign runs only in the Host; Main validates/caches the exact immutable stage-zero prefix and reasserts it after overrides. Only private scheduling env/config carries it. Human shells strip it. Admission uses the original local curl grant or the CLI's inherited HTTP loopback proxy. Proxy authentication and the Main bearer remain on curl stdin. A proxy refusal never retries directly; no target is proxied outside the inherited sandbox.

The nested job launcher is intentionally exclusive: the original CLI's inner sandbox may deny PT_TRACE_ME. Its fixed SIP Perl controller uses fork/exec without pre-exec tracing; only authenticated A/B live images can receive Host admission and execute a target. No caller supplies the launcher source. Provider qualification, general supervisor spawning and the external Host observer continue to use the original two-exec authentication barriers. This tradeoff requires independent review and does not authorize proxying project execution outside the inherited sandbox.

Claude Code 2.1.289 was exercised with a private synthetic HOME/provider gateway and its real inner sandbox enabled: baseline and scheduled Make both run, and writing outside the workspace remains denied. The original nested traced launcher returns PT_TRACE_ME EPERM before target birth. The fixed nested launcher plus inherited authenticated proxy receives the physical A/B grant and normal whole-cohort release. The fixture does not add an outer Seatbelt for either inner case, alter allowedDomains, or disable the inner policy. These are local source proofs; the final packaged signed candidate and each remaining native adapter require their own release evidence.
