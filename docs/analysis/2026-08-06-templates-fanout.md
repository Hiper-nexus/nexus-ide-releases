# F2 — rascunho concreto (landar quando a 0.27.0 publicar)

## O ponto de design que apareceu ao escrever

Templates são **dados estáticos**; não conhecem o layout do projeto. O Overclock
resolve isso porque a recipe é executada por um LLM que já leu o repo. Nós não
temos esse luxo num arquivo `.ts`.

**Resolução honesta:** declarar ownership só onde o template **cria** a estrutura
que declara.

- `landing` e `saas` são **greenfield-ish**: as stories constroem as pastas que
  possuem, então declarar caminho é legítimo, não chute.
- `fix` é **single-writer por natureza** (reproduzir→corrigir→regressão).
  **Não vou fingir leque nele.** Fica com 1 unidade, e o veredito de
  elegibilidade explica que é fase sequencial — que é a verdade.

Isso já responde o "limite honesto": template de conserto não alarga; template
de construção alarga.

---

## `saas` — 5 stories, leque real de 5 (o exemplo do Overclock: auth ∥ dados ∥ billing)

| Story | ownershipFiles |
|---|---|
| 1.1 Auth mínima | `src/auth/**`, `src/middleware/auth.ts` |
| 1.2 CRUD do domínio core | `src/domain/**`, `src/db/schema/**` |
| 1.3 Billing stub | `src/billing/**` |
| 1.4 Settings da conta | `src/settings/**` |
| 1.5 Smoke de ponta a ponta | `tests/e2e/**` |

Pairwise-disjunto por construção. **5 raízes ⇒ leque de 5** (teto da máquina: 8).

## `landing` — 3 stories

| Story | ownershipFiles |
|---|---|
| 1.1 Hero e estrutura | `src/components/hero/**`, `src/app/page.tsx` |
| 1.2 Seções de conteúdo | `src/components/sections/**` |
| 1.3 Polish responsivo e a11y | `src/styles/**` |

## `fix` — permanece 1 unidade

Sem `ownershipFiles`. Com o amolecimento por story, isso **não** derruba mais
nada — só ele mesmo serializa.

---

## Amolecimento por story (`mission-wave-pack.ts:466-480`)

Trocar a decisão GLOBAL por decisão POR STORY:

```
// hoje: allStoriesDeclareFiles = stories.every(tem arquivos)
//       -> uma incógnita derruba TODAS

// alvo, por story:
declarada   -> ownershipFiles próprios + WAVE_PACK_DISJOINT_FILES_DOMAIN
não-declarada -> inventário compartilhado + 'sequential-only'
```

Segurança preservada: quem não declara continua sem poder provar disjunção e
toma slot exclusivo — não divide onda com escritor declarado. Muda o **escopo do
castigo**, não o critério.

---

## Veredito do caso MISTO (pedido explícito)

`diagnoseWaveConcurrency` ganha a contagem de serializadas por ownership:

> `"leque: 4 de 5 unidades em paralelo; 1 serializada por ownership não declarada — teto disponível: 8"`

Assim ele **vê** por que uma está esperando, em vez de adivinhar — a mesma
mudança que hoje transformou "está travado" em "está trabalhando".

Campo novo: `serializedByOwnership: number` (contagem de admissíveis que ficaram
de fora por `sequential-only`, distinta de `deferredByCap`).

---

## Prova (spike)

Objetivo templated `saas` ⇒ ler `task_dispatch_queue` no `runtime.sqlite3` e
exigir **N>2 dispatches concorrentes** (esperado: 5, limitado por
`min(maxWorkers, cores-2, panes)`). Medido no banco, nunca na UI.

---

## Ordem de commits
1. `ownershipFiles` no tipo + nos 3 templates (dados) — TDD.
2. Amolecimento por story — TDD, incluindo o caso misto.
3. Veredito com `serializedByOwnership` — TDD.
4. Spike RED→GREEN.
