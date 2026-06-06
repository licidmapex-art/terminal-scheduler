/**
 * Browser-API bootstrap: assigns dbAPI, schedulerAPI, and scenarioAPI onto
 * window before the React app mounts, so all renderer code works unchanged.
 *
 * Import this module at the top of main-web.tsx (before importing App).
 */

import { browserDbApi } from "./db-api";
import { browserSchedulerApi } from "./scheduler-api";
import { browserScenarioApi } from "./scenario-api";

declare global {
  // Allow assignment (preload.d.ts uses readonly-ish declarations)
  interface Window {
    dbAPI: typeof browserDbApi;
    schedulerAPI: typeof browserSchedulerApi;
    scenarioAPI: typeof browserScenarioApi;
  }
}

window.dbAPI = browserDbApi;
window.schedulerAPI = browserSchedulerApi;
window.scenarioAPI = browserScenarioApi;

export { browserDbApi, browserSchedulerApi, browserScenarioApi };
export { serializeStore, hydrateStore } from "./db-api";
