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
})
