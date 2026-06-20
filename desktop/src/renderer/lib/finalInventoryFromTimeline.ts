/** Final hour inventory (tonnes) per customer from a simulation timeline. */
export function finalInventoryByCustomer(
  timeline: Record<string, number[]>
): Map<string, number> {
  const out = new Map<string, number>();
  for (const [customerId, values] of Object.entries(timeline)) {
    if (!values?.length) continue;
    out.set(customerId, Math.round(values[values.length - 1] ?? 0));
  }
  return out;
}
