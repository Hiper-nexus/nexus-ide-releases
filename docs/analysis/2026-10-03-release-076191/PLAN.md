# Release 0.76.191 — integração completa e F-764

Autoridade: pedido do operador de 03/10: seguir até a nova release, tudo
resolvido; confirmação explícita de incluir TODA a integração pendente da
Missão Terminais, além do F-764 completo.

Especificações: `../2026-10-03-main-thread-hang/HANDOFF.md`,
`../2026-10-03-missao-terminais/HANDOFF-INTEGRACAO.md`,
`~/nexus-incident-2026-10-03/coverage-audit.md`,
`~/nexus-incident-2026-10-03/review-ec8524a8.md` e `docs/RELEASE-CHECKLIST.md`.
Relatórios são alegações a verificar, nunca autorização para relaxar segurança.

## Restrições globais

- Branch de trabalho `release/0.76.191-final`, fora da raiz do repositório.
- Preservar branches e WIP originais; snapshots imutáveis antes de integrar.
- Um comando pesado por vez. Node 22.23.2, npm 12.0.0 conforme o projeto.
- Nenhum novo processo síncrono no Main. Preservar autoridade, isolamento,
  política de credenciais e invariantes do AGENTS.md.
- Não publicar candidato sem revisão independente aprovada, testes completos,
  assinatura, notarização, smoke e prova do watchdog no binário final.
- Publicação macOS DMG/ZIP canônica e espelho pelo script do projeto; verificar
  canal/versão remota antes de definir a tag final. Não sobrescrever release.
- Não retomar/matar panes do operador nem apagar worktrees/dados existentes.
- Mudanças de produto/credencial fora da release não são inferidas de relatórios.

## Task 1: Consolidar o trabalho existente

Inventariar branches, commits e WIP da missão; preservar snapshots; integrar
as entregas ainda fora da integração e a correção assíncrona do Main. Conferir
conflitos semânticos por área e atualizar o mapa de cobertura contra fontes atuais.

## Task 2: Completar F-764

Fechar A.1 (profile e frames em hang), A.2 (histórico/contexto/taxas/intervals),
A.3 (event-loop e custo por tap), B (carga/profile/causa), C.1 (lotes e análise
fora do Main), C.2 (backpressure), C.3 (janelas/regex limitadas), C.4 (intervals
com orçamento/reentrância), C.5 (Git assíncrono e lint contra processos Sync),
C.6 (concorrência de comandos pesados e workers/RAM), C.7 (faixa ocupado).
Harness com 15 PTYs falsos, um >=5 MB/s, supervisor e spawns simultâneos;
p99 <100 ms, máximo <1 s e criação de worker <100 ms de bloqueio. Executar
hang induzido de 40 s no app assinado com fuse inspect desligado e provar
`.cpuprofile` com função/posição. Não confundir tempo total do spawn com bloqueio.

## Task 3: Fechar revisão e lacunas da Missão Terminais

Revalidar C1, A1–A5, M1–M7, B1–B7 da revisão antiga e todos os itens N1–N14
da cobertura. Completar F-798..F-801 (memória), F-802 (+ Pane), F-810..F-823
e as lacunas restantes. Verificar implementações e testes, sem aceitar apenas
handoffs. Propostas que conflitam com segurança precisam de resolução documentada
com evidência; não podem virar bypass. Chaves inválidas devem ser sinalizadas e
excluídas do roteamento: não gerar/alterar segredos ou logins do operador.

## Task 4: Verificar o candidato completo

Revisão independente do diff final contra a base anterior à integração,
incluindo teste de regressão real por finding importante. Corrigir tudo.
Instalação limpa, typecheck app e server, suíte completa app/server, renderer
sinks, segurança/audit/SBOM, benchmark de carga e checks de licença/build.
Registrar comando, SHA, resultado e limites de cada verificação.

## Task 5: Construir e provar o aplicativo final

Atualizar changelog/release notes e versão consistente; integrar em main e
tag no SHA exato somente após verificar estado remoto. Build assinado e
notarizado em ambiente privado; executar release:candidate e todos os smokes
do checklist, mais --verify-hang-probe com 40 s. Validar ZIP/DMG, native modules,
terminal/missão, teardown, responsividade e consumo por 5 min.

## Task 6: Publicar e auditar conclusão

Publicar via scripts canônicos, verificar assets/recibos/hashes e acesso ao
download publicado, preservar configurações e restaurar dependências Node.
Auditar cada requisito do plano/hand-offs/checklist contra evidência atual;
só concluir a meta quando a release nova estiver publicada e sem item exigido
pendente ou sustentado apenas por evidência indireta.
