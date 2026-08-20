# NexusIDE — QA Finding & Fix Protocol

Protocolo canônico para registrar, corrigir e verificar bugs do NexusIDE. Inspirado no `qa-finding-protocol` do Overclock, mas adaptado para o ciclo de vida Electron + TypeScript + better-sqlite3 do Nexus.

## Local dos findings

Use **1 arquivo por bug** em:

```
docs/qa/items/F-XXX.md
```

Nunca um ledger único. Nunca appenda no final de um só arquivo. Cada novo bug cria um novo `F-XXX.md`.

---

## Formato F-XXX

```markdown
# F-XXX — <título curto>

## F-XXX | categoria: funcional|usabilidade|visual|performance|seguranca | severidade: alta|media|baixa | status: aberto
- Tela/fluxo: <qual tela, componente ou fluxo>
- Arquivo:linha: `<caminho/relativo:linha>` (para bugs de review estático)
- Passos: 1) ... 2) ...
- Esperado: ...
- Observado: ...
- Evidencia: <screenshot, log, output de teste, diff>
- (resolvedor) Correcao: <preenchido ao corrigir>
```

## Ciclo de status

```
aberto → corrigido → verificado
            ↓
        reaberto
            ↓
     precisa-decisao
```

- `aberto` — registrado, ninguém corrigiu.
- `corrigido` — fix aplicado, typecheck e testes focados passaram, `Correcao:` preenchida.
- `verificado` — outro par de olhos (ou o próprio QA) reproduziu e confirmou.
- `reaberto` — reproduziu e AINDA quebra; anote o que persiste e adicione nova evidência.
- `precisa-decisao` — dúvida de produto/UX; registre a pergunta objetiva e pare de tentar adivinhar.

## Faixas de ID (anti-colisao)

- `F-0XX` — visão/manual/UX.
- `F-1XX` — orquestração (`src/main/orch/`).
- `F-2XX` — PTY/sessão (`src/main/pty/`).
- `F-3XX` — renderer/UI (`src/renderer/`).
- `F-4XX` — runtime/segurança (`src/main/runtime/`).
- `F-5XX` — build/package/infra.

Antes de registrar: liste `docs/qa/items/`, ache o maior ID da sua faixa, use o próximo. Nunca recicle, nunca registre fora da faixa.

## Evidência

Sem evidência não é finding. Exemplos de evidência aceitável:

- Screenshot da UI com a falha.
- Trecho de log do processo main/renderer/PTY.
- `git diff` ou `arquivo:linha` do problema.
- Output de `npx vitest run <test>.test.ts` que falha.
- Output de `npm run security:renderer-sinks` ou `npx tsc --noEmit`.

## Anti-duplicata

Antes de criar um `F-XXX`, faça `grep -R` em `docs/qa/items/` pelo componente, arquivo ou sintoma.

- Mesmo defeito já registrado → não duplique. Se você tem evidência nova, acrescente no `F-XXX.md` existente.
- Mesmo sintoma, causa diferente comprovada → novo finding com referência ao antigo (`relacionado a F-XXX`).
- `corrigido`/`verificado` que voltou → `reaberto` no MESMO ID, nunca ID novo.

## Severidade

- `alta` — bloqueia missão/uso; perda de dados/worktree; feature principal quebrada; crash.
- `media` — atrapalha mas tem workaround (ex: recarregar, retomar missão).
- `baixa` — polish, cosmético, copy, alinhamento.

## Correção

1. Leia o arquivo apontado + call sites + evidência até entender a **causa raiz**. Sintoma ≠ causa.
2. Aplique o fix mínimo. Sem refactor de carona, sem "enquanto estou aqui" em código adjacente.
3. Valide ANTES de marcar `corrigido`:
   - `npx tsc --noEmit` passa na área afetada.
   - `npx vitest run <source>.test.ts` passa.
   - Se tocou renderer or IPC, `npm run security:renderer-sinks` passa.
   - Se mudou visual, capture screenshot antes/depois.

## Commit

- 1 finding = 1 commit.
- `git add` SÓ dos arquivos que você tocou para aquele finding — **nunca `git add -A` ou `git add .`**.
- Mensagem com o ID: `fix(área): F-XXX — resumo do fix`.
- Dois findings no mesmo arquivo = ainda assim commits separados, na ordem em que corrigiu.

## Atualização do contrato

Após commit + validação, em `docs/qa/items/F-XXX.md`:

- `status: aberto` → `status: corrigido`.
- Preencha `(resolvedor) Correcao:` com:
  - causa raiz em 1-2 frases;
  - arquivos alterados + hash do commit;
  - como validou (comandos que rodaram).

## Exceções

- Dúvida de produto (comportamento esperado ambíguo, decisão de UX/escopo): marque `precisa-decisao` + pergunta objetiva e siga para o próximo. Não decida sozinho, não trave.
- 3 tentativas máximas na mesma abordagem. Na 3ª falha, registre no finding o que tentou e mude de abordagem ou devolva no handoff.
- Nunca derrube processo que você não subiu (produção pode estar rodando). Para matar dev, use PID específico; jamais `pkill` por nome.

## Handoff de QA

Quando esgotar os `aberto` elegíveis ou atingir o orçamento do ciclo:

- handoff com IDs corrigidos;
- lista de `precisa-decisao` pendentes;
- clusters/arquivos restantes.
