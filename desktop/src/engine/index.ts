/**
 * Scheduling engine – public API.
 */

export { runScheduler } from "./scheduler";
export type { ScheduleResult, SchedulerRunOptions } from "./scheduler";
export { replaySimulation } from "./replaySimulation";
export { finalizeManualSlot, defaultModeForResource, defaultLegKey, volumeFromOccupation, occupationEndFromVolume } from "./manualSlot";
export { validateScheduledSlots } from "./validateScheduledSlots";
export type { SlotValidationIssue } from "./validateScheduledSlots";
export {
  lastCompletedEndHourForLeg,
  resolveTransportRow,
  poolsById
} from "./transportPools";
export {
  initGradeInventoryLedger,
  applyGradeAttributedFlow,
  maxOutboundTonnesWithinGradeFloor,
  sharedInventoryFloorBlocks,
  customerHasGradeMix,
  snapshotGradeLedger,
  summarizeGradeLedgerTimeline,
  computeQuarterlyAttributedGradeStock
} from "./gradeInventoryLedger";
export type {
  GradeInventoryLedger,
  GradeLedgerTimeline,
  GradeStockSummaryRow,
  QuarterlyGradeStockRow
} from "./gradeInventoryLedger";
export {
  buildTimeline,
  buildInventoryTimelines,
  getProjectedInventory,
  getCustomerMaxCapacity,
  simulationPeriodHoursFloored,
  tallyPipelineTonnesFromSimulationLog,
  tallyRefusedTonnesAtTankExtremes,
  countPipelineInterruptionHours,
  planSharedInventoryPipelineOutboundHour,
  terminalTotalBeforePipelineHour,
  applySharedInventoryOutboundFlow,
  applyBerthCargoToInventory,
  theoreticalInventoryDeltaWithoutTankClamp,
  customerStorageShareFrac,
  replaySharedShippingTerminalFlowTotals,
  attributeSharedShippingFlowsToCustomers,
  attributeSharedShippingFlowsForAnalytics
} from "./inventory";
export type {
  InventoryTimeline,
  TankExtremeRefusalTonnes,
  SharedShippingTerminalFlowTotals,
  SharedShippingAttributedFlows
} from "./inventory";
export { runFeasibilityChecks } from "./feasibility";
export { runPostRunFeasibilityChecks } from "./postRunFeasibility";
export type { SchedulingLeg } from "./feasibility";
export type { SimulationLogRow, TransportModeStatus } from "./simulationLog";
export {
  applySlotTimeAdjustments,
  eventsActiveAtHour,
  immobilisationWarnings,
  pipelineMultiplierForHour,
  sampleDistribution,
  sampleSimulationOverrides,
  createRng,
  randomSeed
} from "./stochastic";
export type { SampleOverridesResult } from "./stochastic";
export type { ReplaySimulationOptions } from "./replaySimulation";
export {
  computeHourlyBerthTonnesByBucket,
  tallyBerthTonnesByCustomerFromSlots,
  buildSimulationWorkbook,
  writeSimulationWorkbookToBuffer
} from "./simulationExcelExport";
