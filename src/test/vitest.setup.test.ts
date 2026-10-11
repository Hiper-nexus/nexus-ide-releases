import childProcess from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { JEV_ENV_VAR } from '../shared/jev-ipc'

/**
 * Invariante de higiene do processo de teste.
 *
 * O Jev é um serviço de TERCEIRO: toda chamada manda o `state` para
 * api.typesafe.ai. A chave do operador vive em ~/.config/typesafe/env e é
 * sourçada pelo ~/.zshenv, então ela entra no `process.env` de qualquer
 * `npm test` rodado no shell dele — e aí qualquer superfície que consulte
 * `hasJevCredential()` passa a fazer rede de verdade durante os testes.
 *
 * O estrago é triplo: egress de dados não consentido (objetivo de missão,
 * comando, caminho do workspace), resultado não determinístico (depende do
 * que o modelo responder) e suíte que fica verde no CI e vermelha na máquina
 * de quem escreveu o código. Quem precisa exercitar o Jev injeta `hasKey` e
 * `judge` — nunca depende de uma credencial ambiente.
 */
describe('higiene do processo de teste', () => {
  it('não carrega a credencial real do TypeSafe', () => {
    // Asserção sobre PRESENÇA, nunca sobre o valor: `toBeUndefined()` numa
    // env populada imprime a chave real na mensagem de falha, e daí ela vaza
    // para o log do CI e para o scrollback de quem rodou a suíte — o teste
    // que existe para proteger o segredo seria o próprio vazamento.
    expect(process.env[JEV_ENV_VAR] === undefined).toBe(true)
  })

  it('não herda a admissão heavy do pane onde a suíte foi lançada (F-1216)', () => {
    // Só nomes e caminhos: o token do gate nunca entra na mensagem de falha.
    const inherited = Object.keys(process.env).filter((key) => key.startsWith('NEXUS_HEAVY_') || key === 'NEXUS_GATE_TOKEN')
    expect(inherited).toEqual([])
    expect(process.env.BASH_ENV ?? '').not.toMatch(/heavy-command/)
    expect(process.env.ZDOTDIR ?? '').not.toMatch(/heavy-(command|zsh-)/)
    expect(process.env.NODE_OPTIONS ?? '').not.toMatch(/heavy-command/)
    // O preload heavy herdado embrulha o child_process do processo (função
    // anônima no lugar da nativa `spawn`); limpo no vitest.config.ts, o
    // worker nasce sem URL e token e o preload fica inerte.
    expect(childProcess.spawn.name).toBe('spawn')
  })
})
