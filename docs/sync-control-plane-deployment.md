# Nexus sync control plane

O `OptimisticSyncEngine` pode usar o backend HTTP persistente sem depender de
filesystem compartilhado entre computadores. O transporte é opt-in e usa a
mesma sessão Bearer já armazenada pelo Nexus em `safeStorage`.

## Contrato HTTP

- `GET /v1/sync/projects/:projectId` lê a revisão e as entidades da conta
  autenticada.
- `PUT /v1/sync/projects/:projectId` recebe `expectedRevision` e o estado
  completo normalizado. A gravação só ocorre se a revisão remota ainda for
  exatamente a esperada.
- `409 revision-conflict` ou `409 entity-version-conflict` são conflitos
  explícitos. Não existe last-write-wins.
- `413 quota-exceeded` identifica `projects-per-account`,
  `entities-per-project` ou `bytes-per-project`.
- `serverTime` vem do servidor. O cliente não envia timestamps de autoridade.

O namespace físico é `(accountId, projectId)`. Contas diferentes nunca leem
ou alteram o estado uma da outra, mesmo usando o mesmo `projectId`. Esta versão
não implementa compartilhamento entre contas ou ownership por time.

## Dados permitidos

O contrato aceita somente os tipos já definidos pelo sync engine:

- `mission-metadata`
- `context-fact`
- `context-decision`
- `regression`
- `contract-metadata`
- `ledger-metadata`

Cada entidade possui identificador portátil, `baseVersion`, `entityVersion`
incrementada exatamente em uma unidade e JSON validado. O filtro compartilhado
entre desktop e servidor rejeita:

- secrets, tokens, cookies, authorization e credentials, inclusive padrões
  comuns encontrados dentro de strings;
- prompts e source contents/source code;
- provider/account sessions;
- `installationId`, `checkoutId`, paths, cwd, working directory e coordenadas
  de workspace;
- objetos com prototype não-JSON, números não finitos, duplicatas e nesting
  excessivo.

Não envie conteúdo de arquivos, prompts ou credenciais sob nomes alternativos.
O transporte foi desenhado para metadados portáveis, revisões de contexto e
metadados de evidência, não para espelhar o banco local inteiro.

## Quotas e limites

- 500 projetos por conta;
- 1.000 entidades por projeto;
- 192 KiB de estado canônico por projeto;
- corpo HTTP global de 256 KiB;
- resposta desktop padrão de 256 KiB;
- timeout desktop padrão de 5 segundos;
- 120 operações de sync por minuto/IP, além do limiter global.

Criações concorrentes de projetos bloqueiam a linha da conta durante a
verificação da quota. Os checks de entidades e bytes também existem no banco.

## Configuração do desktop

Produção exige a mesma origem HTTPS usada pela autenticação:

```text
NEXUS_BACKEND_URL=https://api.example.com
NEXUS_SYNC_BACKEND_URL=https://api.example.com
```

HTTP só é aceito em teste local explícito:

```text
NODE_ENV=test
NEXUS_BACKEND_URL=http://127.0.0.1:3100
NEXUS_SYNC_BACKEND_URL=http://127.0.0.1:3100
NEXUS_SYNC_ALLOW_INSECURE_LOCALHOST_TEST=1
```

Snippet de composição para o bootstrap do processo principal:

```ts
import { OptimisticSyncEngine } from './context/sync-engine';
import { createHttpSyncBackendFromEnvironment } from './context/http-sync-backend';

const syncBackend = createHttpSyncBackendFromEnvironment();
const syncEngine = syncBackend
  ? new OptimisticSyncEngine(syncBackend)
  : null;
```

Ausência de `NEXUS_SYNC_BACKEND_URL`, falha de rede, resposta malformada,
autenticação expirada ou quota excedida não autorizam fallback para memória.
A operação compartilhada deve permanecer indisponível até o backend voltar.

## Deploy

1. Execute `npm run db:migrate -w @nexus/server` para aplicar a migration
   `0005_futuristic_madrox.sql`.
2. Execute `npm run build -w @nexus/server`.
3. Configure liveness em `GET /live` e readiness em `GET /ready`. O alias
   legado `/health` não consulta PostgreSQL e não deve ser usado para promoção.
4. Configure as duas URLs com a mesma origem HTTPS.
5. Faça login no desktop e valide um publish CAS em dois computadores usando
   o mesmo `projectId` e a mesma conta.

Os timeouts de conexão, query, statement e readiness usam as variáveis
`DATABASE_*_TIMEOUT_MS`; o cleanup usa `SERVER_CLEANUP_TIMEOUT_MS`. Todos estão
documentados em `docs/cron-control-plane-deployment.md`, recebem defaults
seguros e impedem o boot quando ficam fora de 100–60.000 ms.
