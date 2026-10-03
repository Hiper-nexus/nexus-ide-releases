# N13 — proposta de compatibilidade para pastas novas no macOS

Há conflito entre a melhoria registrada no coverage-audit (pasta de worktrees
com sufixo `.noindex`) e AGENTS.md / managed-worktree-layout.ts (layout histórico
macOS/Linux preservado byte a byte). A mudança abaixo está proposta, não aplicada.

## Caminhos propostos

Somente no macOS, novas worktrees usariam
`<runtime>/worktrees.noindex/project-H/checkout-H/task-H`, preservando todos os
componentes atuais depois da raiz. Novos candidatos usariam
`<runtime>/merge-candidates.noindex/scope-H/candidate-H`.

Registros atuais continuam apontando para seus caminhos atuais. Nenhum diretório
seria renomeado, movido ou substituído por symlink. Leitura, retomada e limpeza
precisariam aceitar explicitamente as duas raízes em managed-worktree-layout,
como o mecanismo já faz para o legado Windows. Linux e Windows não mudariam.

## Verificação necessária

Testar criação nova, recuperação de registro legado, retomada de worktree com
WIP, referências de candidatos, coleta nas duas raízes e rejeição de caminhos
fora delas. Confirmar que o checkout não recebe arquivos extras.

O sufixo não será apresentado como prova de que o Spotlight causou o incidente
original. Sua eficácia no sistema instalado exige teste separado de indexação.
Não será usado `.metadata_never_index` como substituto sem comprovação, nem
alterada a lista de privacidade do Spotlight ou outra preferência do operador.

## Decisão pendente

Autorizar a exceção para NOVAS raízes no macOS, com compatibilidade do legado,
ou manter a regra atual e encerrar N13 como proposta incompatível com ela.
