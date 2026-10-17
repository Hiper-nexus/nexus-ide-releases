import { describe, expect, it } from 'vitest'
import {
  CODEX_LOGOUT_WARNING,
  getAgentSlashCommands,
  sessionSlashCommandSuggestions
} from './native-chat-slash-commands'

/**
 * `codex logout` revoga o token no provedor (auth.openai.com/oauth/revoke, medido
 * no Codex 0.162): a conta que o Nexus guardou com essa sessão para de funcionar.
 * O menu `/` não pode oferecer o comando como um "sair" inofensivo.
 */
describe('/logout do Codex avisa que revoga a conta', () => {
  it('o catálogo descreve a revogação em PT-BR', () => {
    const logout = getAgentSlashCommands('codex').find((command) => command.name === 'logout')
    expect(logout?.description).toBe(CODEX_LOGOUT_WARNING)
    expect(CODEX_LOGOUT_WARNING).toMatch(/revoga a sessão desta conta no provedor/)
    expect(CODEX_LOGOUT_WARNING).toMatch(/conta salva no Nexus deixa de funcionar/)
  })

  it('a descrição neutra que a própria sessão relata não apaga o aviso', () => {
    const rows = sessionSlashCommandSuggestions('codex', [
      { name: 'logout', kind: 'command', description: 'Log out of Codex' },
      { name: 'model', kind: 'command', description: 'Choose the model' }
    ])
    expect(rows.find((row) => row.name === 'logout')?.description).toBe(CODEX_LOGOUT_WARNING)
    // Os demais comandos seguem com a descrição da sessão.
    expect(rows.find((row) => row.name === 'model')?.description).toBe('Choose the model')
  })
})
