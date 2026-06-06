export {};

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
        feasibilityWarnings: string[];
        inventoryTimeline: Record<string, number[]>;
      }>;
      getSlots: () => Promise<unknown[]>;
      getSimulationLog: () => Promise<unknown[]>;
      getFeasibilityWarnings: () => Promise<string[]>;
      exportSimulationExcel: () => Promise<
        { ok: true; path: string } | { ok: false; error: string }
      >;
      getInventoryTimeline: () => Promise<{
        timeline: Record<string, number[]>;
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
      getSimulationConfigs: () => Promise<unknown[]>;
      createSimulationConfig: (c: unknown) => Promise<unknown>;
      updateSimulationConfig: (id: string, c: unknown) => Promise<unknown>;
    };
  }
}
