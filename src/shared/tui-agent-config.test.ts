import { describe, expect, it } from 'vitest'
import { TUI_AGENT_CONFIG, getTuiAgentLaunchCommand } from './tui-agent-config'

describe('fresh TUI launch commands', () => {
  it.each(['darwin', 'linux', 'win32'] as const)('never select a previous conversation on %s', (platform) => {
    for (const config of Object.values(TUI_AGENT_CONFIG)) {
      expect(getTuiAgentLaunchCommand(config, platform).split(/\s+/))
        .not.toEqual(expect.arrayContaining([expect.stringMatching(/^(?:--continue(?:=.*)?|-c|--resume(?:=.*)?|-r|latest|--last)$/)]))
    }
  })
})
