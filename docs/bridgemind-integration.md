# BridgeMind → Nexus

Esta integração embarca somente padrões úteis, em modo clean-room, dos
projetos MIT do [BridgeMind](https://github.com/bridge-mind):

- [BridgeWard](https://github.com/bridge-mind/BridgeWard): tratar conteúdo
  externo como dados, marcar proveniência e detectar prompt injection,
  exfiltração, SSRF, Unicode invisível e scripts de instalação.
- [BridgeSecurity](https://github.com/bridge-mind/BridgeSecurity): revisar
  limites de confiança, segredos, execução dinâmica, sinks HTML e leituras de
  arquivos sensíveis.
- [BridgeBench](https://github.com/bridge-mind/bridgebench): manter manifestos
  imutáveis, hashes, IDs de execução e journal append-only verificável.

## Uso no Nexus

O MCP expõe duas ferramentas somente leitura:

- `nexus_content_audit`: audita texto ou um arquivo relativo ao workspace.
- `nexus_security_audit`: aplica a auditoria de conteúdo e regras adicionais
  para código-fonte.

As ferramentas nunca executam nem alteram o alvo. Entradas MCP são validadas
com schema estrito; caminhos passam pelo mesmo limite de workspace usado pelas
outras ferramentas; e a proveniência acompanha o resultado. O parâmetro
`provenance` aceita exatamente `unknown` (padrão), `user`, `repo-trusted`,
`repo-untrusted`, `web-page`, `mcp-tool-result`, `mcp-tool-description` e
`file-external` (`CONTENT_PROVENANCES`, `src/main/security/content-audit.ts`); qualquer
outro valor é recusado com `unsupported content provenance`. As skills compactas citam
esses mesmos valores.

As skills compactas `bridgeward` e `bridgesecurity` também são espelhadas para
os agentes quando a configuração de skills não usa uma allowlist explícita.

O runner em `src/main/eval/benchmark-runner.ts` agora inicia partidas
head-to-head em memória, em ordem determinística, com executor e juiz
injetáveis. O juiz recebe apenas `A` e `B`, sem identidade dos modelos. Falhas
de um competidor viram `forfeit`; falhas dos dois ou juiz inválido viram
`no-contest`. O resultado já alimenta o ranker de `nexus-eval`.

`src/main/eval/benchmark-journal.ts` grava JSONL append-only e verifica todo o
arquivo antes de cada append. O journal contém hashes e metadados, nunca as
respostas ou referências privadas. A integração com cada CLI/provider ainda
fica deliberadamente na borda `executeCompetitor`; não há chamada paga ou rede
automática embutida no runner.

## Execução real opt-in

`src/main/eval/cli-benchmark-executor.ts` adapta os `spawn.headless` declarados
pelos adapters do Nexus. Ele usa `spawn(..., { shell: false })`, ambiente
mínimo por allowlist, limite de saída, timeout e encerra grupo de processos.
`allowExternalExecution: true` é obrigatório; sem isso nenhum provider é
iniciado.

Antes de publicar um resultado, valide o manifest e o journal:

```bash
npm run eval:benchmark:verify -- \
  --manifest ./runs/manifest.json \
  --journal ./runs/journal.jsonl
```

Somente um journal não vazio e integralmente verificado pode passar por
`applyVerifiedBenchmarkRunToCatalog`. A publicação continua sendo uma função
pura; o Nexus não grava ranking remoto nem faz chamadas pagas sozinho.

Não há cópia do runtime upstream no Nexus; a atribuição está em
`THIRD_PARTY_NOTICES.md`.
