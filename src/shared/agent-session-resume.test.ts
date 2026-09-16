import { describe, expect, it } from 'vitest'
import { extractAgentProviderSession, getAgentResumeArgv, isResumableTuiAgent, type ResumableTuiAgent } from './agent-session-resume'

const resumes: [string, string[]][] = [
  ['cursor', ['cursor-agent', '--resume', 'session-123']],
  ['hermes', ['hermes', '--resume', 'session-123']],
  ['copilot', ['copilot', '--resume=session-123']],
  ['droid', ['droid', '--resume', 'session-123']],
  ['goose', ['goose', 'session', '--resume', '--session-id', 'session-123']],
  ['command-code', ['command-code', '--session', 'session-123']],
]

describe('explicit provider resume', () => {
  it.each(resumes)('resumes %s by captured id only', (agent, argv) => {
    expect(isResumableTuiAgent(agent)).toBe(true)
    expect(getAgentResumeArgv(agent as ResumableTuiAgent, { key: 'session_id', id: 'session-123' })).toEqual(argv)
    expect(getAgentResumeArgv(agent as ResumableTuiAgent, { key: 'conversation_id', id: 'session-123' })).toBeNull()
    for (const id of ['', ' ', 'latest', '--continue', 'abc\n', 'a'.repeat(513)]) {
      expect(getAgentResumeArgv(agent as ResumableTuiAgent, { key: 'session_id', id })).toBeNull()
    }
  })

  it('captures Cursor conversation identity, never the generation identity', () => {
    expect(extractAgentProviderSession('cursor', { conversation_id: 'chat-123', generation_id: 'turn-1' })).toEqual({ key: 'session_id', id: 'chat-123' })
    expect(extractAgentProviderSession('cursor', { generation_id: 'turn-1' })).toBeNull()
    expect(extractAgentProviderSession('cursor', { session_id: 'chat-123' })).toEqual({ key: 'session_id', id: 'chat-123' })
  })

  it.each(['hermes', 'command-code'] as const)('captures %s hook session ids', (source) => {
    expect(extractAgentProviderSession(source, { session_id: 'session-123' })).toEqual({ key: 'session_id', id: 'session-123' })
    expect(extractAgentProviderSession(source, {})).toBeNull()
  })

  it.each(['pi', 'prime-agent'] as const)('preserves the authoritative transcript requirement for %s', (agent) => {
    expect(getAgentResumeArgv(agent, { key: 'session_id', id: 'session-123' })).toBeNull()
    expect(getAgentResumeArgv(agent, { key: 'session_id', id: 'session-123', transcriptPath: '/private/sessions/chat.jsonl' })?.at(-1)).toBe('/private/sessions/chat.jsonl')
  })
})
