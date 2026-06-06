/**
 * Domain types for the terminal scheduling engine.
 * Minimal types to satisfy the API contract. Extend as needed.
 */

export type Direction = "inbound" | "outbound";

export type TransportMode = "ship" | "barge" | "pipeline" | "train";

export type ResourceType = "berth" | "pipeline" | "rail_siding" | "loading_arm";

export interface TimeWindow {
  earliest: Date;
  latest: Date;
}

export interface Resource {
  id: string;
  name: string;
  type: ResourceType;
  maxConcurrent?: number;
}

export interface Product {
  id: string;
  name: string;
}

export interface Customer {
  id: string;
  name: string;
}

export interface TransportRequest {
  id: string;
  direction: Direction;
  mode: TransportMode;
  productId: string;
  customerId: string;
  volume: number;
  requestedWindow: TimeWindow;
  estimatedDurationHours: number;
  priority: number;
  sequence?: number;
  preferredStart?: Date;
}

export interface ScheduledEvent {
  id: string;
  requestId: string;
  direction: Direction;
  mode: TransportMode;
  productId: string;
  customerId: string;
  volume: number;
  start: Date;
  end: Date;
  resourceIds: string[];
}

export interface UnscheduledRequest {
  requestId: string;
  reason: string;
}

export interface ScheduleProposal {
  events: ScheduledEvent[];
  unscheduledRequestIds: string[];
  unscheduled?: UnscheduledRequest[];
}

export interface InventorySnapshot {
  customerId: string;
  productId: string;
  at: Date;
  volume: number;
}

export function addHours(base: Date, hours: number): Date {
  return new Date(base.getTime() + hours * 60 * 60 * 1000);
}

export function maxDate(a: Date, b: Date): Date {
  return a.getTime() >= b.getTime() ? a : b;
}

export function overlaps(aStart: Date, aEnd: Date, bStart: Date, bEnd: Date): boolean {
  return aStart < bEnd && bStart < aEnd;
}
