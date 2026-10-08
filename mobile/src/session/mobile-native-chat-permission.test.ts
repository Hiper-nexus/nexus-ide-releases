import { describe, expect, it } from 'vitest'
import { detectAgentPermission, parseApprovalFromStatus } from './mobile-native-chat-permission'
import { decodeApprovalResponseToken } from './mobile-structured-agent-prompts'

describe('detectAgentPermission', () => {
  it('returns null for a working agent even with permission-like text', () => {
    expect(
      detectAgentPermission({
        state: 'working',
        lastAssistantMessage: 'Do you want to proceed? (y/n)'
      })
    ).toBeNull()
  })

  it('returns null when state is undefined', () => {
    expect(
      detectAgentPermission({ lastAssistantMessage: 'Do you want to proceed? (y/n)' })
    ).toBeNull()
  })

  it('returns null for ordinary prose while blocked', () => {
    expect(
      detectAgentPermission({
        state: 'blocked',
        lastAssistantMessage: 'I finished editing the file and ran the tests.'
      })
    ).toBeNull()
  })

  it('returns null when the message is empty', () => {
    expect(detectAgentPermission({ state: 'waiting', lastAssistantMessage: '   ' })).toBeNull()
  })

  it('detects a (y/n) prompt and offers Allow/Deny with y/n send values', () => {
    const result = detectAgentPermission({
      state: 'waiting',
      lastAssistantMessage: 'Allow running `rm -rf build`? (y/n)'
    })
    expect(result).not.toBeNull()
    expect(result?.title).toBe('Permissão solicitada')
    expect(result?.options).toEqual([
      { label: 'Permitir', send: 'y' },
      { label: 'Negar', send: 'n' }
    ])
    expect(result?.detail).toContain('Allow running')
  })

  it('detects a numbered allow/deny menu and sends the digit', () => {
    const result = detectAgentPermission({
      state: 'blocked',
      lastAssistantMessage:
        'Claude wants to edit App.tsx. Do you want to proceed?\n' +
        '1. Yes\n' +
        '2. No, and tell Claude what to do differently'
    })
    expect(result).not.toBeNull()
    expect(result?.options).toHaveLength(2)
    expect(result?.options[0]).toEqual({ label: 'Yes', send: '1' })
    expect(result?.options[1]?.send).toBe('2')
    expect(result?.options[1]?.label).toContain('No')
  })

  it('handles parenthesized numbered options "1) Yes 2) No"', () => {
    const result = detectAgentPermission({
      state: 'waiting',
      lastAssistantMessage: 'Approve this command?\n1) Yes\n2) No'
    })
    expect(result?.options.map((o) => o.send)).toEqual(['1', '2'])
  })

  it('supports a three-option numbered menu (Yes / Yes always / No)', () => {
    const result = detectAgentPermission({
      state: 'blocked',
      lastAssistantMessage:
        "Allow this tool call?\n1. Yes\n2. Yes, and don't ask again this session\n3. No"
    })
    expect(result?.options).toHaveLength(3)
    expect(result?.options.map((o) => o.send)).toEqual(['1', '2', '3'])
  })

  it('adds an "Allow always" option when the text offers a persistent grant', () => {
    const result = detectAgentPermission({
      state: 'waiting',
      lastAssistantMessage:
        'Do you want to allow this? You can allow always for this session. (y/n)'
    })
    expect(result?.options.map((o) => o.label)).toEqual(['Permitir', 'Permitir sempre', 'Negar'])
    expect(result?.options.map((o) => o.send)).toEqual(['y', 'a', 'n'])
  })

  it('detects keyword-only permission asks without explicit y/n tokens', () => {
    const result = detectAgentPermission({
      state: 'blocked',
      lastAssistantMessage: 'I need your permission to run this Bash command.'
    })
    expect(result).not.toBeNull()
    expect(result?.options.map((o) => o.send)).toEqual(['y', 'n'])
  })

  it('detects "approve" / "deny" phrasing', () => {
    const result = detectAgentPermission({
      state: 'waiting',
      lastAssistantMessage: 'Please approve or deny this write to /etc/hosts.'
    })
    expect(result).not.toBeNull()
    expect(result?.options).toHaveLength(2)
  })

  it('truncates a very long detail line', () => {
    const long = `Do you want to proceed? ${'x'.repeat(300)}`
    const result = detectAgentPermission({ state: 'waiting', lastAssistantMessage: long })
    expect(result).not.toBeNull()
    expect((result?.detail ?? '').length).toBeLessThanOrEqual(160)
  })

  it('shortens long numbered option labels', () => {
    const result = detectAgentPermission({
      state: 'blocked',
      lastAssistantMessage:
        'Proceed?\n1. Yes\n2. No, and explain in great detail exactly why this particular approach is wrong'
    })
    const second = result?.options[1]
    expect(second?.send).toBe('2')
    expect((second?.label ?? '').length).toBeLessThanOrEqual(40)
  })
})

describe('parseApprovalFromStatus', () => {
  it('parses an approval envelope into an Allow/Deny card', () => {
    const card = parseApprovalFromStatus(
      JSON.stringify({ approval: { tool: 'Bash', summary: 'rm -rf build' } })
    )
    expect(card?.title).toBe('Permitir Bash?')
    expect(card?.detail).toBe('rm -rf build')
    expect(card?.options.map((o) => o.label)).toEqual(['Permitir', 'Negar'])
    expect(card?.options[0]!.send).toBe('1')
  })

  it('returns null for non-approval / malformed input', () => {
    expect(parseApprovalFromStatus(undefined)).toBeNull()
    expect(parseApprovalFromStatus('{bad')).toBeNull()
    expect(parseApprovalFromStatus(JSON.stringify({ questions: [] }))).toBeNull()
    expect(parseApprovalFromStatus(JSON.stringify({ approval: {} }))).toBeNull()
  })
})

describe('parseApprovalFromStatus — structured host approval (PRV-02/MOB-07)', () => {
  const structured = {
    tool: 'Bash',
    summary: 'touch probe.txt',
    requestId: 'req-1',
    revision: 1,
    options: [
      { optionId: 'accept' },
      { optionId: 'acceptForSession', degradesTo: 'accept' },
      { optionId: 'decline' }
    ],
    responseCapability: 'live'
  }

  it('answers with decision tokens, never keystrokes', () => {
    const card = parseApprovalFromStatus(JSON.stringify({ approval: structured }))
    expect(card?.structured).toBe(true)
    expect(card?.options.map((o) => o.label)).toEqual([
      'Permitir',
      'Permitir (só este pedido)',
      'Negar'
    ])
    for (const option of card!.options) {
      expect(option.send).not.toBe('1')
      expect(option.send).not.toBe(String.fromCharCode(27))
    }
    expect(decodeApprovalResponseToken(card!.options[2]!.send)).toEqual({
      itemId: 'req-1',
      expectedRevision: 1,
      optionId: 'decline'
    })
  })

  it('shows no card for a request nobody is waiting on any more', () => {
    expect(
      parseApprovalFromStatus(
        JSON.stringify({ approval: { ...structured, responseCapability: 'closed' } })
      )
    ).toBeNull()
  })

  it('a broken structured envelope never falls back to the keystroke card', () => {
    expect(
      parseApprovalFromStatus(JSON.stringify({ approval: { ...structured, revision: 'x' } }))
    ).toBeNull()
  })
})
