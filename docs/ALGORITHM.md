# Algorithm for Terminal Scheduler

## 1. Objective

The tool simulates planning for a period of time for a marine terminal with different modes of inbound and outbound product (pipeline, ship, barge, train). Each mode has different input parameters.

## 2. Products and Units

- The simulation works for different products; units may be tons or m³.
- If m³ is selected, pipeline mode may be gaseous (lower density) while transport units are liquid (higher density).
- The terminal converts: gaseous → liquid (pipeline to transport) or liquid → gaseous (transport to pipeline).
- **Input required**: Density conversion factor to account for phase difference.

## 3. Overall Objective

Determine slots for transport units in the most efficient way between transport modes and different customers to achieve the desired throughput, **always respecting the constraints**.

## 4. Master Log (Single Source of Truth)

Maintain a master log tracking on an **hourly basis**:

- Pipeline inbound flow
- Pipeline outbound flow
- Transport unit loading or unloading rate
- Inventory of each customer
- Inventory of the terminal

## 5. Graph and Slot Indication

- Master log drives the graph showing evolution of inventory per customer and terminal inventory.
- Above the graph: indication of whether a slot is planned and for which transport mode.

## 6. Ticker-Based Scheduling

Slots are scheduled using a **ticker + constraint** approach, processed hour-by-hour.

### Ticker

- A ticker increments by 1 each hour.
- When the ticker reaches a predefined threshold, a slot is triggered and the ticker resets.
- **Threshold formula**: `periodHours / (desiredThroughputOverPeriod / parcelSize)` = `periodHours × parcelSize / desiredThroughputOverPeriod`
- Example: 30 days (720 h), desired throughput 100 units, parcel size 10 → 10 slots → interval = 720/10 = **72 hours** between slots.

### Hour-by-Hour Flow

1. Each hour: apply pipeline flow, apply transport events (loading/unloading).
2. Increment tickers for each (customer, direction) with transport.
3. When ticker ≥ threshold: attempt to schedule a slot for that customer/direction.
4. Before placing: check constraints (see §7).
5. If constraints pass: place slot, reset ticker.
6. If constraints fail: adapt (move slot earlier/later), then pipeline interrupt, then error report.

### Conflict Resolution

- **inbound_first** (default): process inbound tickers before outbound.
- **outbound_first**: process outbound before inbound.
- **round_robin**: alternate when both have due slots.

## 7. Constraint Check (Before Each Slot)

Before definitively planning a slot, the model checks:

| Constraint | Description |
|------------|-------------|
| **a. Minimum inventory** | Customer (if no borrowing) or terminal (if borrowing) must have sufficient inventory for the parcel. |
| **b. Maximum inventory** | Customer (if limited storage entitlement) or terminal. Entitlement types: **fixed** (max amount over period) or **allowance_decreasing** (start amount linearly decreasing over N days). |
| **c. No overlap** | No overlap of slots or transport modes (configurable: `all` or `per_mode`). |
| **d. Minimum spacing** | Minimum hours between slots for a customer or the terminal. |
| **e. Other** | Potential constraints to be added. |

## 8. Adaptation When Constraint Violated

1. **Adapt**: Move the slot earlier or later (within a search window); make consequential changes to other slots to resolve the conflict.
2. **If no solution**: Interrupt pipeline flow for that hour.
3. **If still no solution**: Error report pointing to likely issue, e.g.:
   - Insufficient outbound capacity or inventory
   - Insufficient terminal storage capacity
   - etc.

## 9. Customer Treatment

- **No customer priority** – all customers treated equally.

## 10. Future Additions

- Stochastic element for simulating delays (after deterministic model is fixed)
- KPI report
