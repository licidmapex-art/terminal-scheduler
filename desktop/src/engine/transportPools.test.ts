import { describe, expect, it } from "vitest";
import type { Customer, ScheduledSlot, TransportPool } from "../types";
import type { SchedulingLeg } from "./feasibility";
import {
  applyProportionalPoolFlow,
  attributeSlotTonnesToInventory,
  initProportionalPoolTerminal,
  lastCompletedEndHourForLeg,
  lastLegSlotStartHourForLeg,
  poolInventoryShareFrac,
  resolveTransportRow,
  slotMatchesRoundtripScope,
  syncPoolMemberInventories,
  transportRowForSlot
} from "./transportPools";

function makeCustomer(id: string, name: string): Customer {
  return {
    id,
    name,
    currentInventory: 1000,
    storageShare: 50,
    pipelineFlowPerHour: 0,
    declaredInboundThroughput: 10000,
    inboundMEPS: 1000,
    inboundMode: "train",
    inboundRoundtripHours: 24,
    outboundMEPS: 0,
    outboundMode: "ship",
    outboundRoundtripHours: 0,
    timeSharedMinBand: 0,
    timeSharedDuration: 24,
    inboundTransports: [
      { mode: "train", sharePct: 100, meps: 1000, roundtripHours: 24, poolId: "pool-train" }
    ]
  };
}

const trainPool: TransportPool = {
  id: "pool-train",
  name: "Train 1",
  mode: "train",
  roundtripHours: 48,
  meps: 1000,
  inventoryAllocation: "attributed"
};

describe("resolveTransportRow", () => {
  it("returns the leg unchanged (clubs are name-only)", () => {
    const row = resolveTransportRow(
      { mode: "train", sharePct: 100, meps: 900, roundtripHours: 36, poolId: "pool-train" },
      [trainPool]
    );
    expect(row.roundtripHours).toBe(36);
    expect(row.meps).toBe(900);
  });
});

describe("pool-aware roundtrip", () => {
  const simStart = new Date("2025-01-01T00:00:00Z");
  const simStartMs = simStart.getTime();
  const customers = [makeCustomer("a", "A"), makeCustomer("b", "B")];
  customers[1]!.inboundTransports = [
    { mode: "train", sharePct: 100, meps: 1000, roundtripHours: 24, poolId: "pool-train" }
  ];

  const legA: SchedulingLeg = {
    customer: customers[0]!,
    direction: "inbound",
    mode: "train",
    laneKey: "inbound-train-1",
    meps: 1000,
    targetSlots: 5,
    roundtripHours: 48,
    poolId: "pool-train",
    inventoryAllocation: "attributed"
  };

  const slots: ScheduledSlot[] = [
    {
      id: "s1",
      customerId: "b",
      resourceId: "r1",
      direction: "inbound",
      mode: "train",
      volume: 1000,
      start: new Date(simStartMs),
      end: new Date(simStartMs + 6 * 60 * 60 * 1000),
      status: "scheduled",
      conflictReason: null,
      legKey: "inbound-train-1"
    }
  ];

  it("matches slots from other customers on the same pool", () => {
    expect(slotMatchesRoundtripScope(slots[0]!, legA, customers, [trainPool])).toBe(true);
  });

  it("uses latest pool slot start for round-trip anchor (start-to-start)", () => {
    const lastStart = lastLegSlotStartHourForLeg(legA, slots, simStartMs, 10, customers, [trainPool]);
    expect(lastStart).toBe(0);
    const lastEnd = lastCompletedEndHourForLeg(legA, 10, slots, simStartMs, customers, [trainPool]);
    expect(lastEnd).toBe(6);
  });
});

describe("proportional pool roundtrip", () => {
  const proportionalPool: TransportPool = {
    id: "pool-ship",
    name: "Ship fleet",
    mode: "ship",
    roundtripHours: 100,
    meps: 2000,
    inventoryAllocation: "proportional"
  };
  const simStartMs = new Date("2025-01-01T00:00:00Z").getTime();
  const customers = [makeCustomer("a", "A"), makeCustomer("b", "B")];
  customers[1]!.inboundTransports = [
    { mode: "ship", sharePct: 100, meps: 2000, roundtripHours: 100, poolId: "pool-ship" }
  ];

  const legA: SchedulingLeg = {
    customer: customers[0]!,
    direction: "inbound",
    mode: "ship",
    laneKey: "inbound-ship-1",
    meps: 2000,
    targetSlots: 5,
    roundtripHours: 100,
    poolId: "pool-ship",
    inventoryAllocation: "proportional"
  };

  const slotB: ScheduledSlot = {
    id: "s1",
    customerId: "b",
    resourceId: "r1",
    direction: "inbound",
    mode: "ship",
    volume: 2000,
    start: new Date(simStartMs),
    end: new Date(simStartMs + 6 * 60 * 60 * 1000),
    status: "scheduled",
    conflictReason: null,
    legKey: "inbound-ship-1"
  };

  it("does not treat another customer's pool visit as this leg's roundtrip", () => {
    expect(slotMatchesRoundtripScope(slotB, legA, customers, [proportionalPool])).toBe(false);
    const lastStart = lastLegSlotStartHourForLeg(legA, [slotB], simStartMs, 10, customers, [proportionalPool]);
    expect(lastStart).toBeNull();
  });
});

describe("transportRowForSlot", () => {
  const proportionalPool: TransportPool = {
    id: "pool-ship",
    name: "Ships",
    mode: "ship",
    roundtripHours: 48,
    meps: 2000,
    inventoryAllocation: "proportional"
  };
  const customer: Customer = {
    ...makeCustomer("a", "A"),
    inboundTransports: [
      { mode: "ship", sharePct: 50, meps: 2000, roundtripHours: 48, poolId: "pool-ship" },
      { mode: "barge", sharePct: 50, meps: 1500, roundtripHours: 36 }
    ]
  };

  it("resolves pool vs private leg by legKey index, not first matching mode", () => {
    const pooled = transportRowForSlot(
      customer,
      { direction: "inbound", mode: "ship", legKey: "inbound-ship-1" },
      [proportionalPool]
    );
    const privateLeg = transportRowForSlot(
      customer,
      { direction: "inbound", mode: "barge", legKey: "inbound-barge-2" },
      [proportionalPool]
    );
    expect(pooled?.poolId).toBe("pool-ship");
    expect(privateLeg?.poolId).toBeFalsy();
  });
});

describe("attributeSlotTonnesToInventory", () => {
  const proportionalPool: TransportPool = {
    id: "pool-ship",
    name: "Ship fleet",
    mode: "ship",
    roundtripHours: 100,
    meps: 2000,
    inventoryAllocation: "proportional"
  };

  it("pool slot splits only among direction pool members", () => {
    const customerA: Customer = {
      ...makeCustomer("a", "A"),
      storageShare: 75,
      inboundTransports: [
        { mode: "ship", sharePct: 100, meps: 2000, roundtripHours: 100, poolId: "pool-ship" }
      ]
    };
    const customerD: Customer = {
      ...makeCustomer("d", "D"),
      storageShare: 25,
      inboundTransports: [{ mode: "ship", sharePct: 100, meps: 2000, roundtripHours: 100 }]
    };
    const invById: Record<string, number> = { a: 5000, d: 5000 };

    attributeSlotTonnesToInventory(
      { customerId: "a", direction: "inbound", mode: "ship", legKey: "inbound-ship-1" },
      1000,
      [customerA, customerD],
      [proportionalPool],
      invById
    );

    expect(invById.a).toBe(6000);
    expect(invById.d).toBe(5000);
  });

  it("pool slot with manual colon legKey splits among pool members", () => {
    const customerA: Customer = {
      ...makeCustomer("a", "A"),
      storageShare: 50,
      inboundTransports: [
        { mode: "ship", sharePct: 100, meps: 2000, roundtripHours: 100, poolId: "pool-ship" }
      ]
    };
    const customerB: Customer = {
      ...makeCustomer("b", "B"),
      storageShare: 50,
      inboundTransports: [
        { mode: "ship", sharePct: 100, meps: 2000, roundtripHours: 100, poolId: "pool-ship" }
      ]
    };
    const invById: Record<string, number> = { a: 1000, b: 1000 };

    attributeSlotTonnesToInventory(
      {
        customerId: "a",
        direction: "inbound",
        mode: "ship",
        legKey: "a:inbound:ship:lane0"
      },
      1000,
      [customerA, customerB],
      [proportionalPool],
      invById
    );

    expect(invById.a).toBe(1500);
    expect(invById.b).toBe(1500);
  });

  it("attributed pool still shares inventory among members on load", () => {
    const attributedPool: TransportPool = {
      id: "pool-train",
      name: "Train",
      mode: "train",
      roundtripHours: 48,
      meps: 1000,
      inventoryAllocation: "attributed"
    };
    const customerA: Customer = {
      ...makeCustomer("a", "A"),
      storageShare: 60,
      outboundTransports: [
        { mode: "train", sharePct: 100, meps: 1000, roundtripHours: 48, poolId: "pool-train" }
      ]
    };
    const customerB: Customer = {
      ...makeCustomer("b", "B"),
      storageShare: 40,
      outboundTransports: [
        { mode: "train", sharePct: 100, meps: 1000, roundtripHours: 48, poolId: "pool-train" }
      ]
    };
    const invById: Record<string, number> = { a: 5000, b: 5000 };

    attributeSlotTonnesToInventory(
      { customerId: "a", direction: "outbound", mode: "train", legKey: "outbound-train-1" },
      1000,
      [customerA, customerB],
      [attributedPool],
      invById
    );

    expect(invById.a).toBe(4500);
    expect(invById.b).toBe(4500);
  });

  it("pool split uses live inventory share not storage share", () => {
    const proportionalPool: TransportPool = {
      id: "pool-ship",
      name: "Ship fleet",
      mode: "ship",
      roundtripHours: 100,
      meps: 2000,
      inventoryAllocation: "proportional"
    };
    const customerA: Customer = {
      ...makeCustomer("a", "A"),
      storageShare: 25,
      currentInventory: 8000,
      outboundTransports: [
        { mode: "ship", sharePct: 100, meps: 2000, roundtripHours: 100, poolId: "pool-ship" }
      ]
    };
    const customerB: Customer = {
      ...makeCustomer("b", "B"),
      storageShare: 75,
      currentInventory: 2000,
      outboundTransports: [
        { mode: "ship", sharePct: 100, meps: 2000, roundtripHours: 100, poolId: "pool-ship" }
      ]
    };
    const invById: Record<string, number> = { a: 8000, b: 2000 };
    expect(poolInventoryShareFrac("a", [customerA, customerB], invById)).toBeCloseTo(0.8);
    expect(poolInventoryShareFrac("b", [customerA, customerB], invById)).toBeCloseTo(0.2);

    attributeSlotTonnesToInventory(
      { customerId: "a", direction: "outbound", mode: "ship", legKey: "outbound-ship-1" },
      1000,
      [customerA, customerB],
      [proportionalPool],
      invById
    );

    expect(invById.a).toBe(7200);
    expect(invById.b).toBe(1800);
  });

  it("non-pool slot attributes 100% to booking customer", () => {
    const customerD: Customer = {
      ...makeCustomer("d", "D"),
      storageShare: 25,
      inboundTransports: [{ mode: "ship", sharePct: 100, meps: 2000, roundtripHours: 100 }]
    };
    const invById: Record<string, number> = { d: 5000 };

    attributeSlotTonnesToInventory(
      { customerId: "d", direction: "inbound", mode: "ship", legKey: "inbound-ship-1" },
      800,
      [customerD],
      [proportionalPool],
      invById
    );

    expect(invById.d).toBe(5800);
  });
});

describe("proportional pool inventory", () => {
  const proportionalPool: TransportPool = {
    id: "pool-ship",
    name: "Shared ships",
    mode: "ship",
    roundtripHours: 100,
    meps: 2000,
    inventoryAllocation: "proportional"
  };

  const customerA: Customer = {
    ...makeCustomer("a", "A"),
    storageShare: 60,
    inboundTransports: [
      { mode: "ship", sharePct: 50, meps: 2000, roundtripHours: 100, poolId: "pool-ship" },
      { mode: "barge", sharePct: 50, meps: 1000, roundtripHours: 36 }
    ]
  };

  it("keeps private-leg inventory when pool cargo moves", () => {
    const customers = [customerA];
    const invById: Record<string, number> = { a: 5500 };

    attributeSlotTonnesToInventory(
      { customerId: "a", direction: "inbound", mode: "ship", legKey: "inbound-ship-1" },
      1000,
      customers,
      [proportionalPool],
      invById
    );
    expect(invById.a).toBe(6500);
  });

  it("pool inbound flow does not attribute to customers opted out of the pool", () => {
    const proportionalPool: TransportPool = {
      id: "pool-ship",
      name: "Ship fleet",
      mode: "ship",
      roundtripHours: 100,
      meps: 2000,
      inventoryAllocation: "proportional"
    };
    const customerA: Customer = {
      ...makeCustomer("a", "A"),
      storageShare: 75,
      inboundTransports: [
        { mode: "ship", sharePct: 100, meps: 2000, roundtripHours: 100, poolId: "pool-ship" }
      ]
    };
    const customerD: Customer = {
      ...makeCustomer("d", "D"),
      storageShare: 25,
      inboundTransports: [{ mode: "ship", sharePct: 100, meps: 2000, roundtripHours: 100 }]
    };
    const customers = [customerA, customerD];
    const privateInvById: Record<string, number> = { a: 5000, d: 5000 };
    const invById: Record<string, number> = { a: 5000, d: 5000 };
    const poolTerminal = initProportionalPoolTerminal(customers, [proportionalPool]);

    applyProportionalPoolFlow(
      "pool-ship",
      "inbound",
      1000,
      1,
      poolTerminal,
      privateInvById,
      customers,
      [proportionalPool],
      invById
    );

    expect(invById.a).toBe(6000);
    expect(invById.d).toBe(5000);
  });

  it("inbound pool stock is not shared with customers only on outbound pool", () => {
    const proportionalPool: TransportPool = {
      id: "pool-ship",
      name: "Ship fleet",
      mode: "ship",
      roundtripHours: 100,
      meps: 2000,
      inventoryAllocation: "proportional"
    };
    const customerA: Customer = {
      ...makeCustomer("a", "A"),
      storageShare: 75,
      inboundTransports: [
        { mode: "ship", sharePct: 100, meps: 2000, roundtripHours: 100, poolId: "pool-ship" }
      ]
    };
    const customerD: Customer = {
      ...makeCustomer("d", "D"),
      storageShare: 25,
      inboundTransports: [{ mode: "ship", sharePct: 100, meps: 2000, roundtripHours: 100 }],
      outboundTransports: [
        { mode: "ship", sharePct: 100, meps: 2000, roundtripHours: 100, poolId: "pool-ship" }
      ]
    };
    const customers = [customerA, customerD];
    const privateInvById: Record<string, number> = { a: 5000, d: 5000 };
    const invById: Record<string, number> = { a: 5000, d: 5000 };
    const poolTerminal = initProportionalPoolTerminal(customers, [proportionalPool]);

    applyProportionalPoolFlow(
      "pool-ship",
      "inbound",
      1000,
      1,
      poolTerminal,
      privateInvById,
      customers,
      [proportionalPool],
      invById
    );

    expect(invById.a).toBe(6000);
    expect(invById.d).toBe(5000);
  });
});

describe("pool-only membership", () => {
  const shipClub: TransportPool = { id: "club-ship", name: "Ship club" };

  it("pool-only customer shares inventory on another member's pooled ship load", () => {
    const customerA: Customer = {
      ...makeCustomer("a", "A"),
      currentInventory: 6000,
      outboundMEPS: 1000,
      outboundMode: "ship",
      outboundTransports: [
        { mode: "ship", sharePct: 50, meps: 1000, roundtripHours: 48, poolId: "club-ship" },
        { mode: "ship", sharePct: 50, meps: 800, roundtripHours: 40 }
      ]
    };
    const customerB: Customer = {
      ...makeCustomer("b", "B"),
      currentInventory: 4000,
      outboundMEPS: 0,
      outboundTransports: [{ mode: "pool", sharePct: 0, meps: 0, roundtripHours: 0, poolId: "club-ship" }]
    };
    const invById: Record<string, number> = { a: 6000, b: 4000 };

    attributeSlotTonnesToInventory(
      { customerId: "a", direction: "outbound", mode: "ship", legKey: "outbound-ship-1" },
      1000,
      [customerA, customerB],
      [shipClub],
      invById
    );

    expect(invById.a).toBe(5400);
    expect(invById.b).toBe(3600);
  });

  it("pool-only customer is unaffected by non-pooled leg loads", () => {
    const customerA: Customer = {
      ...makeCustomer("a", "A"),
      currentInventory: 6000,
      outboundTransports: [
        { mode: "ship", sharePct: 50, meps: 1000, roundtripHours: 48, poolId: "club-ship" },
        { mode: "ship", sharePct: 50, meps: 800, roundtripHours: 40 }
      ]
    };
    const customerB: Customer = {
      ...makeCustomer("b", "B"),
      currentInventory: 4000,
      outboundTransports: [{ mode: "pool", sharePct: 0, meps: 0, roundtripHours: 0, poolId: "club-ship" }]
    };
    const invById: Record<string, number> = { a: 6000, b: 4000 };

    attributeSlotTonnesToInventory(
      { customerId: "a", direction: "outbound", mode: "ship", legKey: "outbound-ship-2" },
      800,
      [customerA, customerB],
      [shipClub],
      invById
    );

    expect(invById.a).toBe(5200);
    expect(invById.b).toBe(4000);
  });
});
