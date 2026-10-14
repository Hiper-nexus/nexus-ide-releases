# Brief — rascunho das notas da release 0.76.251

Papel: redator somente leitura. Não edite arquivos do repositório; entregue o texto no handoff.

Repositório: `C:\Users\Administrador\Documents\Projetos\nexus-ide` (leia com `git -C …`).

## O que entra na 0.76.251
1. Branches de squads (base `main` 152c77e82): `fix/windows-heavy-pid-squads` (F-1434, F-1435 — já foram
   para a 0.76.250 por cherry-pick; confirme), `fix/squad-io`, `fix/squad-prep`, `fix/squad-ui`, `fix/squad-win`
   (F-1437..F-1456) e um F-1457 ainda não commitado (agent-spec-writer no Windows: frontmatter CRLF, nomes de
   dispositivo CON/NUL…, nome que só difere na caixa). Leia `docs/qa/items/F-<n>.md` em cada branch
   (`git show <branch>:docs/qa/items/F-<n>.md`) e os títulos dos commits.
2. Correções desta missão (ainda sendo escritas; descreva pelo efeito para o usuário):
   - F-1470: o coordenador (Maestro) voltava recusado com "orchestrator physical spawn authority is missing or
     mismatched" quando a conta escolhida no respawn não era a da aprovação; agora volta na conta com folga do
     mesmo provedor, e a recusa (quando houver) diz o motivo em português.
   - F-1471: worker de missão que esgota a cota troca para outra conta do mesmo provedor e segue a tarefa, em
     vez de ficar na conta esgotada e cair em outra CLI.
   - F-1473: na troca de conta, o Claude continua a MESMA conversa na conta nova (resume nativo), com volta
     automática para sessão nova + resumo se o resume falhar.
   - F-1472: QR do celular — o QR de controle volta a dar controle (token em base64url), o celular mostra por
     que não conectou, as caixas de link copiam o endereço https certo, o QR velho dá lugar a "Gerar novo QR"
     e o relay fecha a sala ociosa direito.

## Formato
Siga exatamente o formato de `src/shared/release-notes.ts` (veja as entradas da 0.76.250, 0.76.249 e 0.76.245
com `git show 7b7d4823b -- src/shared/release-notes.ts` e `git show 152c77e82 -- src/shared/release-notes.ts`):
título curto da versão no estilo dos anteriores (ex.: "Comandos pesados de volta no Windows"), itens no tom e
tamanho dos existentes, PT-BR, foco no efeito para o usuário, sem jargão interno. Proponha o título e o bloco
TypeScript pronto para colar, e o título do commit de release no padrão `chore(release): 0.76.251 — <título>`.

## Entrega
`nexus_handoff_submit` uma vez, com o bloco pronto e a lista de F-números cobertos (marque os que você não
conseguiu confirmar).
