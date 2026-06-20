export {};

type SerializedStochasticRun = NonNullable<
  Awaited<ReturnType<NonNullable<Window["schedulerAPI"]>["getStochasticState"]>>["run"]
>;

type SerializedMonteCarloSnapshot = {
  iterations: number;
  selectedIndex: number;
  baseSeed: number;
  runSeeds: number[];
  aggregates: import("../../types").MonteCarloAggregates;
  customerSummaries: import("../../types").MonteCarloCustomerSummary[];
  hasFullRuns: boolean;
};

declare global {
  interface Window {
    scenarioAPI?: {
      list: () => Promise<Array<{ id: string; name: string; created_at: string }>>;
      save: (name: string) => Promise<void>;
      overwrite: (id: string) => Promise<void>;
      load: (id: string) => Promise<void>;
      delete: (id: string) => Promise<void>;
      rename: (id: string, name: string) => Promise<void>;
    };
    schedulerAPI?: {
      run: () => Promise<{
        scheduledSlots: Array<{
          id: string;
          customerId: string;
          resourceId: string;
          direction: string;
          mode: string;
          legKey?: string | null;
          volume: number;
          start: string;
          end: string;
          status: string;
          conflictReason: string | null;
        }>;
        feasibilityWarnings: Array<{ key: string; severity: "amber" | "red"; message: string }>;
        inventoryTimeline: Record<string, number[]>;
      }>;
      getSlots: () => Promise<unknown[]>;
      getTweakState: () => Promise<{
        hasBaseline: boolean;
        canUndo: boolean;
        needsReplay: boolean;
        isTweaked: boolean;
        slotTweaks: Record<string, "added" | "modified">;
        baselineSlots: unknown[];
      }>;
      getStochasticState: () => Promise<{
        active: boolean;
        run: {
          stochasticSeed?: number;
          slots: unknown[];
          ghostSlots: unknown[];
          simulationLog: unknown[];
          inventoryTimeline: Record<string, number[]>;
          feasibilityWarnings: Array<{ key: string; severity: "amber" | "red"; message: string }>;
          slotAdjustments: Array<{ slotId: string; deltaStartMs: number; deltaEndMs: number; reason: string }>;
          immobilisationWindows: Array<{ resourceId?: string; startMs: number; endMs: number; label: string }>;
          stochasticEvents: unknown[];
        } | null;
      }>;
      sampleStochastic: (seed?: number) => Promise<
        | { ok: true; run: NonNullable<Awaited<ReturnType<NonNullable<Window["schedulerAPI"]>["getStochasticState"]>>["run"]> }
        | { ok: false; error: string }
      >;
      clearStochastic: () => Promise<{ ok: true }>;
      runMonteCarlo: (payload: {
        iterations?: number;
        baseSeed?: number;
      }) => Promise<
        | {
            ok: true;
            snapshot: SerializedMonteCarloSnapshot;
            run: NonNullable<Awaited<ReturnType<NonNullable<Window["schedulerAPI"]>["getStochasticState"]>>["run"]>;
          }
        | { ok: false; error: string }
      >;
      getMonteCarloState: () => Promise<{
        active: boolean;
        snapshot: SerializedMonteCarloSnapshot | null;
        run: NonNullable<Awaited<ReturnType<NonNullable<Window["schedulerAPI"]>["getStochasticState"]>>["run"]> | null;
      }>;
      setMonteCarloIteration: (index: number) => Promise<
        | {
            ok: true;
            snapshot: SerializedMonteCarloSnapshot;
            run: NonNullable<Awaited<ReturnType<NonNullable<Window["schedulerAPI"]>["getStochasticState"]>>["run"]>;
          }
        | { ok: false; error: string }
      >;
      clearMonteCarlo: () => Promise<{ ok: true }>;
      cancelMonteCarlo: () => Promise<{ ok: true }>;
      onMonteCarloProgress?: (
        callback: (payload: { done: number; total: number; phase: string }) => void
      ) => () => void;
      updateSimulation: () => Promise<
        | {
            ok: true;
            scheduledSlots: unknown[];
            feasibilityWarnings: Array<{ key: string; severity: "amber" | "red"; message: string }>;
            inventoryTimeline: Record<string, number[]>;
          }
        | { ok: false; error: string }
      >;
      restoreBaseline: () => Promise<
        | {
            ok: true;
            scheduledSlots: unknown[];
            feasibilityWarnings: Array<{ key: string; severity: "amber" | "red"; message: string }>;
            inventoryTimeline: Record<string, number[]>;
          }
        | { ok: false; error: string }
      >;
      undo: () => Promise<
        | {
            ok: true;
            scheduledSlots: unknown[];
            feasibilityWarnings: Array<{ key: string; severity: "amber" | "red"; message: string }>;
            inventoryTimeline: Record<string, number[]>;
          }
        | { ok: false; error: string }
      >;
      deleteSlot: (slotId: string) => Promise<{ ok: true; slotId: string } | { ok: false; error: string }>;
      upsertSlot: (payload: {
        slot: {
          id?: string;
          customerId: string;
          resourceId: string;
          direction: string;
          mode: string;
          volume: number;
          start: string;
          end: string;
          legKey?: string | null;
        };
        isNew?: boolean;
      }) => Promise<{ ok: true; slot: unknown } | { ok: false; error: string }>;
      getSimulationLog: () => Promise<unknown[]>;
      getFeasibilityWarnings: () => Promise<Array<{ key: string; severity: "amber" | "red"; message: string }>>;
      exportSimulationExcel: () => Promise<
        { ok: true; path: string } | { ok: false; error: string }
      >;
      getInventoryTimeline: () => Promise<{
        timeline: Record<string, number[]>;
        gradeTimeline?: Record<string, Record<"green" | "blue" | "grey", number[]>> | null;
        startDate: string | null;
        totalStorageCapacity?: number | null;
      } | null>;
    };
    dbAPI?: {
      getCustomers: () => Promise<unknown[]>;
      createCustomer: (c: unknown) => Promise<unknown>;
      updateCustomer: (c: unknown) => Promise<unknown>;
      deleteCustomer: (id: string) => Promise<unknown>;
      getResources: () => Promise<unknown[]>;
      createResource: (r: unknown) => Promise<unknown>;
      updateResource: (r: unknown) => Promise<unknown>;
      deleteResource: (id: string) => Promise<unknown>;
      getTransportPools: () => Promise<unknown[]>;
      createTransportPool: (p: unknown) => Promise<unknown>;
      updateTransportPool: (p: unknown) => Promise<unknown>;
      deleteTransportPool: (id: string) => Promise<unknown>;
      getSimulationConfigs: () => Promise<unknown[]>;
      createSimulationConfig: (c: unknown) => Promise<unknown>;
      updateSimulationConfig: (id: string, c: unknown) => Promise<unknown>;
    };
  }
}
