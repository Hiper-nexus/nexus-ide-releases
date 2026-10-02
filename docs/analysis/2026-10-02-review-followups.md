# Regressões concretas da revisão da candidata 0.76.166

O head e860b15faea4a5856475dd703fc30fd9f642254d aprovou CI 36968857284:
19.038 testes, 1.714 arquivos aprovados, 166 testes/8 arquivos ignorados,
typecheck e renderer-sinks. CodeQL também aprovou todas as linguagens. Esses
resultados não são reutilizados como prova automática de alterações posteriores.

## Texto ACP entre turnos

O peer JSON-RPC real em subprocesso reproduziu `hello` seguido de `world`
como `helloworld` no ring volátil do pane. O driver agora acrescenta dois
newlines somente no primeiro chunk público não vazio de uma nova resposta.
Chunks da mesma resposta continuam concatenados; turnos vazios ou somente
thought não acrescentam texto. Cancelamento e tamanho limitado do ring
continuam no contrato existente. A reprodução falhou no driver e860 e passou
na correção; 47 testes locais passaram. A revisão independente confirmou os
hashes e não identificou blocker. Isso não comprova inferência de um provedor.

## Navegador estacionado e mão do operador

O código e860 recusava a janela original quando o gate do Main devolvia um
operador promovido a `user` após a missão, enquanto sua apresentação estava
estacionada. As duas reproduções usam a função real de devolução do gate e
cobrem a ficha física PTY ainda na missão e já devolvida a user: ambas falharam.

A origem captura se essa sessão era a mão promovida do operador. Sua leitura
acompanha a devolução exclusivamente quando o gate confiável é user sem missão
ou incarnation, a sessão física continua na janela original e os escopos de
coordenação/execução são exatos. Identidade, pane, adapter e conta continuam
iguais à captura. A transição não é aceita para ACP ou sessões físicas adotadas
por outra janela. O antigo caller da missão e workers headless dessa missão
não recuperam o coordenador devolvido. A suíte passou com 19/19 testes e
revisão independente; os PTYs/janelas nessa suíte são simulados.

## Preview Windows do head anterior

O run 36968864403 em e860 aprovou 135 testes focados e 22 probes no EXE extraído
do NUPKG, versão 0.76.166. Main emitiu renderer-mounted, functional-ready e
shutdown-complete do inventário físico PTY. Os dois artifacts são unsigned,
privados e temporários; Setup não foi instalado e os bytes não foram baixados
nem re-hashados localmente. API e upload concordam no digest. O harness Windows
não enumera todos os helpers Electron no OS; orphans=[] não é prova exaustiva.

## Preview Linux do head anterior

O run 36968857288 em e860 aprovou 19.043 testes, typecheck/sinks/audit, o gate
Clang 15/GCC 12, o browser funcional real e o build DEB/RPM/ZIP. O artifact
11212025107 foi baixado: SHA-256 local, API e upload iguais a
`c21b3c0286b7e49e77d867bb614ff5c81a8079c1b3a9b7232b690d936a5abe00`.
Formulário salvo, menu aberto, progressão/reinício do jogo e layout mobile foram
confirmados por ações/asserts reais e quatro PNGs de resultado inspecionadas.
A geometria mobile foi 390 px/uma coluna/sem overflow horizontal; não houve
falhas de carregamento. O jogo passou x=40→87 (2 movimentos/7 frames de
controle mantido), reiniciou e avançou x=65 (1 movimento/5 frames). As teclas
são eventos DOM sintéticos, sem inferência ou perfil pessoal de navegador. O aplicativo
empacotado abriu o renderer, mas a probe mission-prepare falhou porque o Codex
não estava instalado/executável. Functional-ready, instalação Ubuntu/Debian,
coleta de pacotes e recibos não foram alcançados. Não há candidata Linux
publicável desse run. As mudanças seguintes exigem uma execução completa nova.

As provas de imagens, instalação, restart, assinatura/notarização e publicação
são superfícies diferentes. Um check de fonte aprovado não substitui nenhuma
delas. Os resultados finais e seus SHAs ficam vinculados aos runs do PR.


## Pré-requisito Linux e persistência

A investigação identificou um pré-requisito ausente no workflow, não um CLI Darwin no pacote: Codex é externo e descoberto pelo PATH. Os workflows agora provisionam o mesmo Codex 0.145.0 usado no Windows, com SRI npm, SHA-256 nativo, arquitetura ELF e execução real de --version em home vazio. O Debian recebe somente o pacote nativo em mount read-only. O resolver real passou de null no PATH vazio para o binário verificado; nenhuma guarda de missão ou resolver de produção foi alterada.

O harness opcional de restart abre cada aplicativo duas vezes em um perfil privado pertencente ao teste. CDP loopback com porta efêmera confirma o PID real, versão por ops.releaseReadiness do Main e pixelMode: false→SET true→GET true no primeiro processo; o segundo processo deve ler true antes de qualquer SET. Há timeout/cancelamento, recusa de perfis/targets alheios e cleanup. O default single-launch continua sem CDP. A fixture Electron real provou dois processos com persistência, mas não era Nexus166; o pacote Nexus ainda exige o run completo. Root executou 124 testes combinados dos helpers, workflows e envelope Debian, todos aprovados. Os smokes de pacote/instalação permanecem gates reais, não substituídos por essa suíte local.


## Rodadas 74c321a e 1f74d25; operatorOpened

O agregado 74c321a encontrou TS2322: PaneAuthzInfo representa usuário por role opcional. 1f74d25 corrige essa representação sem mudar as guardas, e as 19 regressões passaram novamente. CI 36974887559 aprovou typecheck, renderer sinks e 19.091 testes; Windows 36974891235 aprovou 135 testes focados, 22 probes, renderer e encerramento do inventário físico de PTY. São previews específicos desse commit, sem Setup instalado ou assinatura de release.

Linux 36974887561 aprovou typecheck/compilador, mas a fonte falhou somente no teste existente decision-redaction: 502,929 ms versus <500 ms. 19.095 testes passaram. Redator e teste são idênticos à main62c304; a causa do atraso não foi demonstrada e o limite não foi alterado. Nenhum build/runtime/instalação/recibo foi executado nesse run.

A revisão reproduziu mais duas falhas em panes operatorOpened estacionados: terminateMissionRuntime e releaseOperatorOpenedTarget reais devolviam o gate ao usuário, enquanto a origem só aceitava promotedOperatorHand. A origem agora captura também a marca operatorOpened do inventário físico Main. O caminho exige o mesmo gate user limpo, proprietário original e escopos exatos, preservando provider/conta/sessão/pane. Chamadas da missão anterior ou com owner/account/scope/incarnation/mission diferentes continuam recusadas. As duas regressões falharam antes e passaram com 21/21 testes, repetidos pelo autor, root e revisão independente. A fronteira física do PTY é simulada nesses testes; os checks completos do novo head são necessários.

O preview macOS ARM64 adicional usa os gates ad hoc existentes, sem alterar o publicador/notary. A preparação local não demonstra execução Mac; CI hospedado e seus recibos devem registrar o resultado real.

## Rodada 8dac: execução real e origem destacada

CI 36978350328 aprovou typecheck, renderer-sinks e 19.113 testes (1.719 arquivos,
166 testes/8 arquivos ignorados). Windows 36978353719 aprovou 135 testes focados
e o aplicativo extraído do NUPKG: versão 0.76.166, renderer, 22 probes,
179 ferramentas/18 adapters e encerramento do inventário físico PTY.
Setup não foi instalado; o preview permanece unsigned.

macOS ARM64 36978350381 aprovou 45 testes focados e Forge. O app e a cópia
extraída do ZIP passaram nas mesmas 22 probes, com versão 0.76.166 e encerramento
graceful. O recibo nexus.macos-preview/v1 foi lido e validado por CRC32 por
ranges do artifact autorizado. Seu SHA-256 é
aec41cd4c704be34a09a3eb5d6a7d9a00b765bd5dd0ab000aea63f9b68642460.
O checkout real foi cff2f49a572268d4ee60c1ee5142d88418d38b6c, merge de
62c304/8dac, com árvore 08ce7614fc4446d3685f0e8571ea510c6dcc4428 idêntica ao
head. Assinatura ad-hoc; publishable=false, releaseEligible=false e
notarizationRequested=false. DMG não foi instalado. O hash completo do archive
460 MB veio do GitHub/upload; não foi recalculado localmente. O follow-up de
diagnostics inclui o recibo final no artifact pequeno; sua regressão passou 4/4.

Linux 36978350426 aprovou 19.118 testes/161 ignorados, browser real, CLI Codex
verificado e Forge DEB/RPM/ZIP. O primeiro smoke de pacote/restart falhou com
CDP command failed. O helper ocultava a captura do app antes de relançar o erro;
isso não demonstra a causa do erro CDP. Instalação Ubuntu/Debian e recibo Linux
ficaram skipped. O limite existente de 500 ms foi preservado e passou nesta
rodada. Nenhuma instalação ou compatibilidade Wayland é atribuída a esse run.

A revisão seguinte usou source:pending, como a criação real de operatorOpened.
A retenção real de workspace chamou detach e transferiu o pane ao Main; as
duas variantes falharam em 8dac. A correção aceita a devolução confirmada pelo
gate para uma origem operatorOpened fisicamente destacada, exigindo ainda um
runtime Main único, identidade/provider/conta e escopos exatos. A devolução
limpa role e workerIncarnationId no registro Main, além da missão. Adoção por
outra janela antes do primeiro sync, runtime duplicado/ausente e autoridade
alheia continuam negados. Autor, root e revisão independente passaram 23/23.
Inventário e lifetime físico do PTY são fronteiras simuladas nessa regressão;
retenção, termination e gate são produção real. Checks do próximo head continuam
necessários; os resultados de 8dac acima não os substituem.

O follow-up CDP expõe somente método, etapa local e código numérico seguro;
mensagens/dados/expressões do peer não entram no diagnóstico. O harness imprime
a captura e a árvore de processos antes de relançar o mesmo erro, sem emitir
matriz de sucesso ou restartProof nesse caminho. A regressão passou de sete
falhas para 98/98 testes, repetida por root e revisão independente. Não há retry,
alteração de prazo ou gate; a causa do app real ainda exige a próxima execução.

O preload real também foi rastreado no head 8dac: as probes dictation-delivery
e dictation-hold-to-talk criam um shell por IPC, exigem writeConfirmed e dois
ecos onData antes do cleanup. Isso torna os 22 resultados Mac/Windows evidência
de PTY real, além do encerramento. Não é inferência Codex/LLM, input físico de
teclado, inventário de PTY vivo nem prova de todos os helpers Windows no OS.
