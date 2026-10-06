# Revisão antecipada da sessão paralela

Base: `596fa7651`. As alterações ainda estavam sendo implementadas durante a
revisão; este parecer não aprova o conjunto para produção. A integração final
deve conferir os arquivos novamente no commit enviado a `main`.

## Bloqueadores encontrados no diff em andamento

### 1. Prazo de fila maior que o transporte

`src/main/orch/heavy-command-permit.ts` passou a admitir espera de missão de
900 segundos. `resources/heavy-command/request.cjs` e
`file-channel-client.cjs` continuam com 360 segundos; wrappers externos
encerram em 365/370 segundos. Por inspeção do caminho efetivo, uma espera
superior a seis minutos termina no transporte antes de o prazo do pool
expirar. Um teste isolado apenas do pool não prova o contrato completo.

Validar o limite comum em todos os transportes e cancelamento da reserva
quando o cliente encerra. Não prometer 15 minutos enquanto a cadeia inteira
não respeitar esse prazo. A abertura de duas validações pesadas por projeto
e estimativa de 1 GB por suíte também exigem conciliação com a regra atual
de um comando pesado por vez; o consumo de um `tsc` não caracteriza todas
as suítes de clientes.

### 2. Pressão severa tenta estacionar o mesmo pane recusado

`src/main/orch/pane-non-worker-auto-close.ts`, laço adicionado em
`sweepIdlePanes`: o contador avança sem conferir o retorno de
`closeIdlePane`. Quando o mais antigo não oferece retomada e recusa o
estacionamento, ele volta a ser escolhido. Reprodução em memória do código
real com três candidatos: três tentativas no primeiro pane; os outros dois,
estacionáveis, não são considerados.

Manter conjunto de candidatos já tentados neste tick, limitar as tentativas
e contabilizar separadamente estacionamentos efetivos. Revalidar identidade,
elegibilidade e pressão antes de cada ação; preservar `operatorOpened`.

### 3. Worker reutilizado ignora a nova política de fechamento

`src/main/orch/tools-panes.ts` calcula `autoClose`, mas o caminho de
`reused: true` retorna sem aplicá-lo à sessão reutilizada. Worker criado com
`false` continua desarmado após novo pedido com o padrão automático; o
inverso também ignora `false` explícito quando a sessão já estava armada.

Aplicar a política da nova atribuição à sessão exata após envio bem-sucedido,
antes do retorno, com proteção contra mudança de sessão. Cobrir as duas
transições, falha de envio e panes que não podem ser fechados automaticamente.

## Validação exigida na integração

Cobrir missão iniciada pelo `+ Pane` e missão comum: criação, worker novo,
reuso, entrega durável, revisão, conclusão, retomada e saída física. No
spawn novo, a revisão encontrou preservação do relatório e do ledger para
ACK, identidade da sessão no callback e preservação de WIP/branch.

O Jev de momentum também está em elaboração. Na revisão final, conferir
que sua resposta não suprime trabalho independente já pronto apenas porque
há outro comando pesado em execução, nem atua com autoridade obsoleta após
o await. Ainda não há aprovação desse novo caminho.

Os gates de RAM PTY/ACP e as reservas entre agentes e validadores são uma
correção separada, coberta pelo F-256. Ela preserva a política de fila de
`HEAD` na cópia isolada para que a validação não absorva WIP por acidente.
