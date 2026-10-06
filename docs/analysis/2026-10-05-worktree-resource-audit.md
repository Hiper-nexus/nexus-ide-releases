# Worktrees e memória — investigação de 05/10/2026

## Conclusão sustentada pela evidência

Não há prova de que a quantidade de worktrees tenha causado o travamento
investigado. O perfil do Main identificou um laço na leitura da saída PTY
(F-953, corrigido no código). Pastas paradas têm custo de armazenamento;
CLIs, servidores auxiliares, indexadores e validadores vivos têm custo de
RAM/CPU. Cache de filesystem também ocupa memória, mas não equivale a um
processo por worktree.

Inventário leve do repositório, sem percorrer dependências: 54 registros Git
incluindo a raiz, 52 pastas existentes, 13 registros em `project-runtime`,
34 caminhos com `.noindex` e dois registros `prunable`. Entre as 52 pastas,
22 `node_modules` são diretórios e 30 são symlinks. Isso não mede bytes
físicos exclusivos: no APFS os clones podem compartilhar blocos. Nenhuma
worktree, branch, alteração ou processo alheio foi removido nesta auditoria.

## O que o produto já faz

- Worktrees Git compartilham o banco de objetos. A implementação macOS usa
  `clonefile` para dependências e evita cópia integral para outro volume.
  Windows/Linux não recebem esse clone APFS.
- Novas worktrees macOS ficam em raízes `.noindex`, fora da raiz do projeto.
  Caminhos legados são preservados.
- Retomada conserva a árvore vinculada ao pane/aba. Novo writer isolado cria
  uma árvore nova; leitores não precisam de uma árvore de escrita.
- A coleta preserva WIP, commits não integrados e diretórios sem prova de
  ausência de processos. Pastas manuais e abas duráveis não são lixo.

Referências: `src/main/runtime/worktree-cow.ts`,
`src/main/runtime/managed-worktree-layout.ts`,
`src/main/runtime/worktree-runtime-registry.ts`,
`src/main/orch/isolated-writer-worktree.ts`.

## Correção concreta desta investigação

O índice síncrono de símbolos entrava em `.claude/worktrees`, duplicando a
leitura do projeto e misturando símbolos de outros checkouts. F-422 exclui
somente essas subárvores durante a descida. Abrir uma worktree diretamente
continua funcionando; scripts locais de `.claude` continuam indexados.
Reprodução antes: três arquivos lidos em vez de dois. Depois: 18 testes dos
fluxos de índice/contexto passaram e a revisão independente não encontrou
bloqueadores. Não foi medida uma redução de RSS no aplicativo empacotado.

## Decisão para 16 GB e 32 GB

Manter isolamento para escritores paralelos e controlar quantos processos
estão vivos, incluindo startup e encerramento ainda não comprovado. Uma
pasta com várias branches requer escrita sequencial: a branch não fornece
outro índice Git nem outro conjunto de arquivos para um segundo escritor.
Reutilizar o pane/árvore já vinculado à mesma atividade evita criação
desnecessária. Não introduzir um cache compartilhado gravável de dependências
nem apagar árvores automaticamente sem prova de preservação do trabalho.

Os perfis de 16/32 GB nos testes são simulações; esta máquina tem 24 GB.
Missão completa no executável e validação de release continuam sendo gates
separados. Limites conservadores não provam ausência de swap em todo projeto.
