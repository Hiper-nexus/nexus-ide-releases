# F-1567: a chave do cofre contra a Qwen Code real

Prova repetível, com a CLI de verdade, de duas coisas: o overlay do Nexus não deixa
a chave do cofre chegar a um destino hostil, e a precedência e a política de admin
da CLI continuam como o operador as conhece. Cada cenário sobe `qwen -p` com um
`QWEN_HOME` e um HOME descartáveis, o overlay gerado pelo código do Nexus
(`prepareQwenMcpSession`) e dois servidores em loopback:

- **SAFE** (HTTPS): o destino que o Nexus resolveu. A chave deve chegar aqui.
- **EVIL** (HTTPS e HTTP): o que o settings hostil quer. A chave nunca pode chegar.

A chave de cada cenário é única; vazamento é qualquer requisição à EVIL (URL,
cabeçalho ou corpo) que a contenha. Os arquivos do overlay também são varridos
atrás da chave e de um segredo velho do operador. O nome da variável do cofre é
entregue ao atacante nos cenários de "nome conhecido": é o pior caso.

## Rodar

Precisa de Node 22, `qwen` 0.25.2 no PATH, `openssl` e `tsx` (já em `node_modules`).

```sh
export PATH="/opt/homebrew/opt/node@22/bin:$PATH"
cd docs/qa/evidence/2026-10-18-qwen-key-isolation
npx tsx run.mjs --wt ../../../.. -c 4                     # a matriz principal (65)
npx tsx run.mjs --wt ../../../.. --scenarios scenarios-hardening.mjs   # endurecimentos candidatos
npx tsx run.mjs --wt ../../../.. --scenarios scenarios-child.mjs --json /tmp/child.json  # env de um filho do shell
```

Linha de base (o código de antes da correção) sem tocar a árvore de trabalho:

```sh
mkdir /tmp/base && git archive 3aa7c57ab src shared | tar -x -C /tmp/base
ln -s "$PWD/../../../../node_modules" /tmp/base/node_modules   # só leitura; nunca apague
npx tsx run.mjs --wt /tmp/base -c 4
```

Opções: `--only <trecho do id ou do grupo>`, `--timeout <ms>`, `--json <arquivo>`,
`--keep` (mantém os diretórios), `--debug` (acrescenta cauda da CLI e arquivos do
overlay ao JSON). Código de saída 1 se houver vazamento, controle que falhou, probe
que falhou, segredo em disco ou detector que não viu o vazamento plantado.

## Grupos

| Grupo | Qtd | O que mede |
|---|---|---|
| `control` | 7 | positivos: sem config hostil, com catálogo do operador, JSONC/BOM, governado, admin presente. A chave TEM de chegar à SAFE |
| `sanity` | 1 | vazamento plantado: o detector tem de vê-lo |
| `user` | 23 | `~/.qwen/settings.json` reescrito: linha com o nome conhecido (caixa, protocolo, http), `env` interpolando (`${X}`, `$X`, `${X:-d}`, `$$X`, encadeado), OPENAI_*, auth |
| `workspace` | 18 | `.qwen/settings.json` de um repositório clonado, as mesmas famílias |
| `dotenv` | 4 | `.env` do workspace, `.qwen/.env`, `~/.qwen/.env` |
| `prec` | 8 | precedência e admin pelo arquivo de contexto que a CLI carrega: workspace vence usuário, admin vence os dois, `system-defaults.json` fica por baixo, catálogo do admin sobrevive, linha legada |
| `exec` | 4 | código dentro da CLI (hook de comando e HTTP, MCP do workspace e do operador): informativo |

Os 60 cenários declarativos são `control` + `user` + `workspace` + `dotenv` + `prec`.

## Resultado (CLI 0.25.2, macOS, Node 22)

| | `3aa7c57ab` | corrigido |
|---|---|---|
| declarativos com a chave na EVIL | 6 (`w07`, `w09`, `w16`, `w18`, `e02`, `e03`) | **0 de 60** |
| probes de precedência/admin | 1 de 5 (falham `p01`, `p02`, `p03`, `p05`) | **5 de 5** |
| controles positivos (a chave chega à SAFE) | 14 de 14 | 14 de 14 |
| segredo em disco | 0 | 0 |
| detector viu o vazamento plantado | 1 de 1 | 1 de 1 |
| `exec` (hook de comando, hook HTTP, MCP do operador) | vazam; MCP de workspace não | igual |

`results-3aa7c57ab.json` e `results-corrigido.json` guardam o registro de cada
cenário. A classe `exec` não é um caminho declarativo: o código roda com o
ambiente do pane e vê a variável do cofre (e `env` inteiro); o Nexus não a fecha
(`folderTrust` quebra o `.qwen/settings.json` do projeto e `disableAllHooks`
desliga os hooks do operador, ver `scenarios-hardening.mjs`).

## Limites

Só `-p` headless (a TUI interativa e o `/auth` não rodam); só macOS; a política
de admin é simulada com `qwenSystemSettingsPath`/`qwenSystemDefaultsPath` (o
caminho real da plataforma exige root).
