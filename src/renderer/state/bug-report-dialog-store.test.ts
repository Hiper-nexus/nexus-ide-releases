import { beforeEach, describe, expect, it } from 'vitest';
import { useBugReportDialogStore } from './bug-report-dialog-store';

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
});
