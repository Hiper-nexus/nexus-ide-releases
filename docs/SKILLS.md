# Skills

## Contract

Catalog of built-in/custom skills with digest lockfile, drift detection, uninstall-all + backup.
Insert/copy/attach are app-layer actions; skill content is Markdown.

## Ownership

- `src/main/skills/skills-catalog.ts`
- Mirror to agent homes: `skill-mirror.ts`
- Flag: `feature.skills.catalog`

## Skills embutidas

O app leva um conjunto fixo de skills e as materializa em `~/.nexus/generated-skills/`
(`skill-mirror.ts`, `bundledSkillSourceDir`) para espelhar nas CLIs. A cópia gerada é
reparada arquivo a arquivo a partir do bundle (`placeSkillAsset`), então uma build nova
entrega o conteúdo novo sem versão a incrementar.

| Origem | Skills |
|--------|--------|
| `assets/skills/<nome>/SKILL.md` + manifest gerado (`BUNDLED_MANIFESTS`) | `impeccable`, `archify`, `bmad-templates`, `superpowers`, `dembrandt`, `typesafe-ai`, `stack-advisor` e as de papel `oc-pilot`, `oc-builder`, `oc-scout`, `oc-conveyor` |
| Corpo inline em TypeScript (`GENERATED_INLINE_SKILL_BODIES`) | `ponytail`, `grilling`, `nexus-visual-media`, `nexus-pet-studio` e as do BridgeMind em `orch/bridge-mind-skills.ts` (`bridgeward`, `bridgesecurity`) |

- **Editar uma skill de `assets/skills/`:** mude o `SKILL.md`, rode
  `node scripts/bundle-skills.mjs` (o `premake`/`prepackage` também roda) e commite o
  `SKILL.md` junto com o `src/main/orch/<nome>-manifest.ts` gerado; o manifest é
  versionado e não se edita à mão. As vendoradas de terceiros (`impeccable`,
  `superpowers`, `archify`, `typesafe-ai`) seguem o upstream (`impeccable`, `archify` e
  `typesafe-ai` trazem a licença na pasta; os avisos do `impeccable` estão em
  `THIRD_PARTY_NOTICES.md`): não se reescreve o conteúdo delas aqui.
  `dembrandt` e `bmad-templates` são adaptações do Nexus e se mantêm no repositório.
- **Skills de papel.** `oc-pilot` (orquestrador: decompõe, delega, verifica),
  `oc-builder` (executor: uma tarefa, evidência, commit com caminhos explícitos,
  handoff), `oc-scout` (pesquisa somente leitura, achados `arquivo:linha`) e
  `oc-conveyor` (revisão adversarial, nunca corrige). Elas descrevem o contrato de
  `isolatedWriter`/`readOnly`, de `nexus_handoff_submit`/`nexus_handoff_ack` em rodadas, do
  handoff sem missão e da revisão informativa, que o código define em `AGENTS.md`
  ("Via Rápida", "Revisão informativa e portão formal", "Handoff sem missão"). Mudou o
  contrato lá, mude a skill aqui. O Jev só sugere `oc-pilot` e `oc-builder` para quem
  escreve e `oc-scout` e `oc-conveyor` para leitura (`jev-skill-suggestion.ts`).
- **`bridgeward` e `bridgesecurity`** ensinam a mesma postura das auditorias somente leitura
  `nexus_content_audit` e `nexus_security_audit` (`docs/bridgemind-integration.md`). O valor
  de `provenance` que a skill cita tem de ser exatamente um de `CONTENT_PROVENANCES`
  (`security/content-audit.ts`), senão a ferramenta recusa.
- Skills do projeto em `.devin/skills/` (`nexus-goal-governor`, `landing-page-design`) não
  são embutidas: ficam no repositório e valem para quem trabalha nele.

## Error flow

Missing dir → empty catalog. Corrupt lock → null. Uninstall backs up lock first.

## Limits

Preview ≤ 4 KiB; digest SHA-256; ≤ 512 lock entries.

## Migration / rollback

Restore `skills.lock.json.*.bak`.

## Security

No automatic execution of skill content as shell; redaction on terminal insert path.

## Metrics

Drifted skill count; sync status transitions.

## How to test

```bash
npx vitest run src/main/skills/skills-catalog.test.ts
```
