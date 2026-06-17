/**
 * Zustand store – state management for the scheduler UI.
 */

import { create } from "zustand";

interface AppState {
  lastSchedulerRun: number;
  /** Persists across tab navigation while the app session is open. */
  scheduleModifyMode: boolean;
}

export const useStore = create<AppState>(() => ({
  lastSchedulerRun: 0,
  scheduleModifyMode: false
}));

export function setLastSchedulerRun() {
  useStore.setState({ lastSchedulerRun: Date.now() });
}

export function setScheduleModifyMode(enabled: boolean) {
  useStore.setState({ scheduleModifyMode: enabled });
}
