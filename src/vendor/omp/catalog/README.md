# Recorte vendorado do catálogo de modelos do oh-my-pi

- **Origem:** [can1357/oh-my-pi](https://github.com/can1357/oh-my-pi) — `packages/catalog/src/models.json`
- **SHA pinado:** `03c48d073`
- **Licença:** MIT (mesma licença do NexusIDE)

## Conteúdo

- `models-rich.json` — recorte GERADO (não editar à mão) do catálogo completo
  (~1.8MB, 59 providers) com apenas os providers relevantes ao Nexus
  (`anthropic`, `openai`, `openai-codex`, `zai`, `zhipu-coding-plan`,
  `deepseek`, `xai`, `google`, `google-gemini-cli`, `kimi-code`, `moonshot`,
  `openrouter` filtrado por família, `sakana`) e apenas os campos consumidos:
  `id`, `name`, `api`, `cost` (USD/MTok), `contextWindow`, `maxTokens`,
  `reasoning`, `input`.
- Modelos publicados pelo catálogo dinâmico depois do SHA pinado ficam em
  `RELEASE_AUDITED_MODEL_OVERLAYS`, no gerador. Cada overlay registra a versão
  do OMP e o comando local que provou seletor e metadados. Assim uma nova
  execução do script não apaga modelos já auditados para a release.
- O overlay `claude-sonnet-5-5` usa o registro público embutido no binário
  Claude Code **2.1.284**, conferido em 28/09/2026: seletor `first_party`,
  contexto de 1M, saída de 128K, texto/imagem e `tier_2_10` ($2/$10 por MTok,
  cache read $0,20 e write 5min $2,50). O registro local não comprova
  acesso de toda conta nem publicação em CLIs de terceiros. O catálogo mantém
  Sonnet 5 como default e não atribui benchmark ao novo modelo.
- `rich-models.ts` — tipos + normalização + lookup fuzzy sobre o recorte.
- `identity.ts` — classificação de modelId em família/variante, módulo próprio
  derivado de `packages/catalog/src/identity/` do omp (o diretório original
  acopla em `../models`, que carrega o catálogo inteiro — por isso não foi
  vendorado inteiro).

## Como re-sincronizar

```sh
git clone https://github.com/can1357/oh-my-pi /tmp/oh-my-pi
git -C /tmp/oh-my-pi checkout <novo-SHA>
node scripts/vendor-omp-catalog.mjs /tmp/oh-my-pi
```

Depois atualize o SHA pinado neste README, nos headers de atribuição dos
arquivos derivados e valide com `npx vitest run src/main/adapters/`.
