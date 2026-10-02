import { beforeEach, describe, expect, it } from 'vitest';
import { useAttentionInboxStore } from './attention-inbox-store';
import { useBugReportDialogStore } from './bug-report-dialog-store';
import { useCheatsheetStore } from './cheatsheet-store';
import { useCommandPaletteStore } from './command-palette-store';
import { useTerminalGridDialogStore } from './terminal-grid-dialog-store';

describe('useBugReportDialogStore', () => {
  beforeEach(() => {
    useBugReportDialogStore.setState({ isOpen: false });
  });

  it('starts closed', () => {
    expect(useBugReportDialogStore.getState().isOpen).toBe(false);
  });

  it('opens and closes', () => {
    useBugReportDialogStore.getState().open();
    expect(useBugReportDialogStore.getState().isOpen).toBe(true);
    useBugReportDialogStore.getState().close();
    expect(useBugReportDialogStore.getState().isOpen).toBe(false);
  });

  it('opening twice keeps it open', () => {
    useBugReportDialogStore.getState().open();
    useBugReportDialogStore.getState().open();
    expect(useBugReportDialogStore.getState().isOpen).toBe(true);
  });

  it('closes the transient overlays that would fight it for Esc/Tab (their listeners run first)', () => {
    useCommandPaletteStore.setState({ open: true });
    useCheatsheetStore.setState({ open: true });
    useAttentionInboxStore.setState({ open: true });
    useTerminalGridDialogStore.setState({ isOpen: true, options: {} });
    useBugReportDialogStore.getState().open();
    expect(useCommandPaletteStore.getState().open).toBe(false);
    expect(useCheatsheetStore.getState().open).toBe(false);
    expect(useAttentionInboxStore.getState().open).toBe(false);
    expect(useTerminalGridDialogStore.getState().isOpen).toBe(false);
    expect(useBugReportDialogStore.getState().isOpen).toBe(true);
  });
});
