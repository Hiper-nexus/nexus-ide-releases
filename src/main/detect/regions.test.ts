import { describe, expect, it } from 'vitest';

import { sliceRegion, type DetectionInput } from './regions';

function input(screen: string, oscTitle = '', oscProgress = ''): DetectionInput {
  return { screen, oscTitle, oscProgress };
}

const CLAUDE_IDLE_SCREEN = [
  '⏺ Previous answer text',
  '',
  '────────────────────────────────────────',
  '❯ ',
  '────────────────────────────────────────',
  '  ? for shortcuts',
  '',
].join('\n');

describe('sliceRegion', () => {
  it('whole_recent returns the screen untouched', () => {
    expect(sliceRegion(input('a\nb'), 'whole_recent')).toBe('a\nb');
  });

  it('bottom_lines(n) slices the last n lines', () => {
    expect(sliceRegion(input('a\nb\nc\nd'), 'bottom_lines(2)')).toBe('c\nd');
    expect(sliceRegion(input('a'), 'bottom_lines(5)')).toBe('a');
  });

  it('bottom_non_empty_lines(n) skips blank lines from the bottom', () => {
    const screen = 'a\n\nb\nc\n\n\n';
    expect(sliceRegion(input(screen), 'bottom_non_empty_lines(2)')).toBe(
      'b\nc\n\n\n',
    );
    expect(sliceRegion(input('\n\n'), 'bottom_non_empty_lines(3)')).toBe('');
  });

  it('top_non_empty_lines(n) keeps everything through the nth non-empty line', () => {
    const screen = 'a\n\nb\nc\nd';
    expect(sliceRegion(input(screen), 'top_non_empty_lines(2)')).toBe('a\n\nb\n');
    expect(sliceRegion(input(''), 'top_non_empty_lines(1)')).toBe('');
  });

  it('after_last_prompt_marker slices after the last bare › marker', () => {
    const screen = 'before\n› typed\nanswer line\n› \n';
    expect(sliceRegion(input(screen), 'after_last_prompt_marker')).toBe('');
    expect(sliceRegion(input('no marker'), 'after_last_prompt_marker')).toBe(
      'no marker',
    );
  });

  it('before_current_prompt_marker ignores markers reclaimed by a block', () => {
    const screen = 'old\n› typed\n• block after\n';
    // A block marker below the last prompt marker means the prompt is no
    // longer current → the whole screen is returned.
    expect(sliceRegion(input(screen), 'before_current_prompt_marker')).toBe(
      screen,
    );
    const live = 'old\n› \n';
    expect(sliceRegion(input(live), 'before_current_prompt_marker')).toBe(
      'old\n',
    );
  });

  it('whole_recent_without_current_prompt_marker blanks when a prompt is live', () => {
    expect(
      sliceRegion(input('old\n› \n'), 'whole_recent_without_current_prompt_marker'),
    ).toBe('');
    expect(
      sliceRegion(
        input('old\n› typed\n• done\n'),
        'whole_recent_without_current_prompt_marker',
      ),
    ).toBe('old\n› typed\n• done\n');
  });

  it('current_prompt_block_marker finds the block line above the live prompt', () => {
    const screen = '• Working (esc to interrupt)\nstuff\n› \n';
    expect(sliceRegion(input(screen), 'current_prompt_block_marker')).toBe(
      '• Working (esc to interrupt)',
    );
    expect(sliceRegion(input('› \n'), 'current_prompt_block_marker')).toBe('');
  });

  it('after_current_prompt_block_marker slices from the block line down', () => {
    const screen = 'top\n• Working\nmid\n› \n';
    expect(sliceRegion(input(screen), 'after_current_prompt_block_marker')).toBe(
      '• Working\nmid\n› \n',
    );
  });

  it('prompt_box_body extracts between the last two horizontal rules', () => {
    expect(sliceRegion(input(CLAUDE_IDLE_SCREEN), 'prompt_box_body')).toBe(
      '❯ \n',
    );
  });

  it('above_prompt_box keeps everything above the box top border', () => {
    expect(sliceRegion(input(CLAUDE_IDLE_SCREEN), 'above_prompt_box')).toBe(
      '⏺ Previous answer text\n\n',
    );
    expect(sliceRegion(input('no box'), 'above_prompt_box')).toBe('no box');
  });

  it('last_non_empty_above_prompt_box returns the last text line above the box', () => {
    expect(
      sliceRegion(input(CLAUDE_IDLE_SCREEN), 'last_non_empty_above_prompt_box'),
    ).toBe('⏺ Previous answer text');
  });

  it('after_last_horizontal_rule slices below the final rule', () => {
    expect(
      sliceRegion(input(CLAUDE_IDLE_SCREEN), 'after_last_horizontal_rule'),
    ).toBe('  ? for shortcuts\n');
    expect(sliceRegion(input('plain'), 'after_last_horizontal_rule')).toBe(
      'plain',
    );
  });

  it('horizontal rules need ≥3 ─ when a suffix follows', () => {
    const screen = '─── header\nbody';
    expect(sliceRegion(input(screen), 'after_last_horizontal_rule')).toBe(
      'body',
    );
    const short = '──x\nbody';
    expect(sliceRegion(input(short), 'after_last_horizontal_rule')).toBe(short);
  });

  it('osc regions read the dedicated fields, not the screen', () => {
    expect(sliceRegion(input('junk', '✳ title'), 'osc_title')).toBe('✳ title');
    expect(sliceRegion(input('junk', '', '4;0;'), 'osc_progress')).toBe('4;0;');
  });

  it('unknown region specs yield an empty string', () => {
    expect(sliceRegion(input('abc'), 'not_a_region')).toBe('');
  });
});
