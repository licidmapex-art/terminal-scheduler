/** Default storage share from declared inbound throughput weights (0–100). */
export function computeStorageShareFromThroughput(
  declaredInboundThroughput: number,
  allCustomers: Array<{ id?: string; declaredInboundThroughput?: number }>,
  excludeCustomerId?: string
): number {
  const self = Math.max(0, declaredInboundThroughput);
  const othersTotal = allCustomers
    .filter((c) => c.id !== excludeCustomerId)
    .reduce((s, c) => s + Math.max(0, c.declaredInboundThroughput ?? 0), 0);
  const total = othersTotal + self;
  if (total <= 0) {
    const count = allCustomers.filter((c) => c.id !== excludeCustomerId).length + 1;
    return count > 0 ? Math.round((100 / count) * 10) / 10 : 100;
  }
  return Math.round((self / total) * 1000) / 10;
}

export function storageShareAppliesToCapacityBand(storageMode: string | undefined): boolean {
  return storageMode === "fixed_band" || storageMode === "time_shared_storage";
}
