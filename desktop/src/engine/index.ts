/**
 * Scheduling engine – public API.
 */

export { runScheduler } from "./scheduler";
export type { ScheduleResult } from "./scheduler";
export {
  buildTimeline,
  getProjectedInventory,
  getCustomerMaxCapacity,
  simulationPeriodHoursFloored,
  tallyPipelineTonnesFromSimulationLog,
  theoreticalInventoryDeltaWithoutTankClamp
} from "./inventory";
export type { InventoryTimeline } from "./inventory";
export { runFeasibilityChecks } from "./feasibility";
export type { SchedulingLeg } from "./feasibility";
export type { SimulationLogRow, TransportModeStatus } from "./simulationLog";
export {
  computeHourlyBerthTonnesByBucket,
  tallyBerthTonnesByCustomerFromSlots,
  buildSimulationWorkbook,
  writeSimulationWorkbookToBuffer
} from "./simulationExcelExport";
