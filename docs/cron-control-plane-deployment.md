# Cron distribuído: deployment e operação

O cron compartilhado do Nexus usa o servidor Express/Postgres existente como
control plane. Não usa filesystem compartilhado e não trata o arquivo local de
jobs como fonte de verdade entre computadores.

## Estado da integração

- Sem configuração remota, o Nexus **não afirma estar conectado**.
- Jobs `shared` não podem ser criados e não executam sem o control plane.
- Jobs `local` continuam disponíveis somente quando `executionMode: "local"`
  é solicitado explicitamente.
- O projeto precisa de `.nexus/project.json` válido. IDs provisórios derivados
  de path não são portáveis e são recusados para schedules compartilhados.

## Deploy do servidor

1. Faça deploy da mesma aplicação em `server/` usada por auth/billing.
2. Configure os envs obrigatórios já descritos em `server/src/env.ts`, em
   especial `DATABASE_URL` e as chaves de autenticação/licença.
3. Execute as migrations antes de promover a aplicação:

   ```bash
   cd server
   npm run db:migrate
   npm run build
   npm start
   ```

A migration `0004_*` cria:

- `cron_schedules`: definições portáveis versionadas por CAS;
- `cron_leases`: autoridade de lease por conta/projeto/schedule/ocorrência.

O servidor gera o token opaco. Somente SHA-256 do token é persistido. TTL e
expiração usam o relógio do servidor, evitando dependência do clock dos PCs.

Configure o deployment para usar `GET /live` como liveness e `GET /ready`
como readiness. `/ready` só retorna 200 quando o PostgreSQL responde e todas
as migrations exigidas estão presentes; `/health` existe apenas como alias
legado de liveness e não deve promover uma instância.

Os limites abaixo são opcionais e validados no boot (100–60.000 ms):

```bash
export DATABASE_CONNECTION_TIMEOUT_MS=5000
export DATABASE_QUERY_TIMEOUT_MS=10000
export DATABASE_STATEMENT_TIMEOUT_MS=8000
export DATABASE_READINESS_TIMEOUT_MS=5000
export SERVER_CLEANUP_TIMEOUT_MS=2000
```

Não desative os timeouts. Probe, startup e encerramento falham fechados quando
o PostgreSQL não responde dentro desses limites.

## Configuração do desktop

O recurso é opt-in. As duas URLs devem ter exatamente a mesma origem para que
um Bearer de sessão nunca seja enviado a um host diferente:

```bash
export NEXUS_BACKEND_URL="https://api.exemplo.com"
export NEXUS_CRON_BACKEND_URL="https://api.exemplo.com"
```

O usuário precisa estar autenticado no Nexus. `auth:session` e `auth:refresh`
continuam no `safeStorage` do sistema operacional; nenhum segredo entra no
repositório ou em `settings.json`.

HTTP é recusado. A única exceção é localhost durante teste explícito:

```bash
export NODE_ENV=test
export NEXUS_BACKEND_URL="http://127.0.0.1:8080"
export NEXUS_CRON_BACKEND_URL="http://127.0.0.1:8080"
export NEXUS_CRON_ALLOW_INSECURE_LOCALHOST_TEST=1
```

Não habilite essa exceção em produção ou para IPs da LAN.

## Modelo de consistência

Uma definição remota contém somente:

- `projectId` e `scheduleId` portáveis;
- versão e hash canônico;
- cron, nome, brief, alvo e cwd relativo opcional;
- status `active`, `paused` ou o tombstone `deleted`.

`installationId`, `checkoutId`, raiz absoluta e paths da máquina permanecem
locais. Cada PC materializa a definição no seu próprio checkout. Alterações
usam `expectedVersion`; duas escritas concorrentes produzem um conflito HTTP
409 explícito, nunca last-write-wins.

Antes de executar, o lease também valida versão e hash da definição. Assim, um
PC com cache obsoleto ou arquivo local alterado não consegue obter autoridade.
Backend indisponível, timeout, resposta acima de 256 KiB ou resposta inválida
mantêm o job fechado e sem catch-up.

## Operação e limites atuais

- Timeout do cliente: 5 segundos por operação.
- Budget de resposta: 256 KiB.
- Rate limit das rotas cron: 180 requests/minuto/IP, além do limite global.
- Schedules são isolados por conta autenticada. Compartilhamento entre contas
  diferentes de um mesmo time ainda exige um owner/tenant de projeto próprio.
- Projetos conhecidos são sincronizados a partir dos workspaces recentes; um
  checkout novo precisa ser aberto ao menos uma vez para receber seu binding
  local.
- Projetos com volume de schedules que exceda o budget precisam de paginação
  antes de aumentar o limite; o cliente falha fechado em vez de truncar.
