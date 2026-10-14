# Brief — roteiro de teste da release 0.76.251 (Windows)

Papel: planejador de QA somente leitura. Não edite o repositório; entregue o roteiro no handoff.

Repositório: `C:\Users\Administrador\Documents\Projetos\nexus-ide` (Electron/TypeScript; leia com `git -C …`).
Leia `package.json` (scripts `test`, `typecheck`, `lint`, `test:mission-e2e`, `dist*`), `scripts/mission-e2e.mjs`,
`docs/multi-account-matrix.md` (seção de testes ~82-89), `src/main/runtime-gates.ts`, `src/preload/runtime-gates.ts`
e `src/main/soak-smoke.ts` (gates de runtime que já existem).

## O que a release leva
- F-1470: Maestro volta na conta com folga do mesmo provedor; a recusa diz o motivo.
- F-1471: worker de missão troca de conta no mesmo provedor e segue a tarefa.
- F-1473: na troca de conta, o Claude continua a mesma conversa (resume nativo), com fallback para sessão nova.
- F-1472: QR do celular (token base64url, mensagens no celular, links https, "Gerar novo QR", relay fecha sala ociosa).
- Branches de squads F-1434..F-1457 (`git log main..fix/squad-io`, `fix/squad-prep`, `fix/squad-ui`, `fix/squad-win`,
  `fix/windows-heavy-pid-squads`; itens em `docs/qa/items/F-<n>.md` de cada branch).

## Máquina de teste
Windows 11, duas contas Claude cadastradas no Nexus, contas Codex/AGY/OpenCode. O relay do celular está fora do
ar (o teste do QR só vale com relay local: `server/` tem o relay; veja como subir local e apontar o desktop para
ele). Não há celular físico garantido: proponha validação com o navegador do desktop (o PWA abre no navegador).

## Entregue
1. Gates automáticos, em ordem, com o comando exato e o tempo esperado (o que é obrigatório antes da release
   e o que é aceitável falhar por plataforma Windows — procure nos `docs/qa/items/F-14*.md` as contagens
   "falhas antes/depois").
2. Roteiro manual curto e objetivo, um bloco por item acima, com passos, resultado esperado e como forçar a
   condição (ex.: como simular "limite de uso" de uma conta sem gastar a cota — existe hook/sonda/flag de teste
   no código? procure em `failover.ts`, `limit-detector.ts`, `runtime-gates.ts`, `soak-smoke.ts`).
3. Para o cenário do cliente (missão criada numa build anterior, app atualizado, Maestro religando): como
   reproduzir localmente.
4. Riscos de regressão mais prováveis para observar.

`nexus_handoff_submit` uma vez, em PT-BR (até ~900 palavras).
