/**
 * Zustand store – state management for the scheduler UI.
 */

import { create } from "zustand";

interface AppState {
  lastSchedulerRun: number;
}

export const useStore = create<AppState>(() => ({
  lastSchedulerRun: 0
}));

export function setLastSchedulerRun() {
  useStore.setState({ lastSchedulerRun: Date.now() });
}
