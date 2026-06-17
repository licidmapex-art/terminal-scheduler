export interface ShareAdjustRow {
  sharePct: number;
  shareFixed?: boolean;
}

function clampShare(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.min(100, Math.max(0, v));
}

/** Nudge shares so they sum to 100; remainder goes to `preferIndex` when provided. */
function rebalanceTo100(rows: ShareAdjustRow[], preferIndex?: number): ShareAdjustRow[] {
  const next = rows.map((r) => ({ ...r, sharePct: clampShare(r.sharePct) }));
  const sum = next.reduce((s, r) => s + r.sharePct, 0);
  const delta = 100 - sum;
  if (Math.abs(delta) < 0.001) return next;
  const idx =
    preferIndex != null && preferIndex >= 0 && preferIndex < next.length
      ? preferIndex
      : next.findIndex((r) => !r.shareFixed);
  if (idx < 0) return next;
  next[idx] = { ...next[idx], sharePct: clampShare(next[idx].sharePct + delta) };
  return next;
}

/**
 * When the user edits share on row `changedIndex`, apply the new value.
 * Fixed rows (except the edited row) keep their share; other movable rows scale proportionally.
 */
export function adjustTransportShares(
  rows: ShareAdjustRow[],
  changedIndex: number,
  newSharePct: number
): ShareAdjustRow[] {
  if (rows.length === 0) return rows;
  if (changedIndex < 0 || changedIndex >= rows.length) return rows;

  const next = rows.map((r) => ({ ...r, sharePct: clampShare(r.sharePct) }));
  const clamped = clampShare(newSharePct);
  next[changedIndex] = { ...next[changedIndex], sharePct: clamped };

  if (next[changedIndex].shareFixed) {
    return next;
  }

  const fixedTotal = next.reduce(
    (s, r, i) => s + (r.shareFixed && i !== changedIndex ? r.sharePct : 0),
    0
  );
  const movableOthers = next
    .map((r, i) => ({ r, i }))
    .filter(({ r, i }) => !r.shareFixed && i !== changedIndex);

  const budgetForOthers = 100 - fixedTotal - clamped;

  if (movableOthers.length === 0) {
    next[changedIndex].sharePct = clampShare(100 - fixedTotal);
    return next;
  }

  const otherSum = movableOthers.reduce((s, { r }) => s + r.sharePct, 0);
  if (otherSum <= 0) {
    const equal = budgetForOthers / movableOthers.length;
    for (const { i } of movableOthers) {
      next[i].sharePct = clampShare(equal);
    }
  } else {
    for (const { r, i } of movableOthers) {
      next[i].sharePct = clampShare((budgetForOthers * r.sharePct) / otherSum);
    }
  }

  return rebalanceTo100(next, changedIndex);
}

/** After removing a row, give a single remaining leg 100%. */
export function sharesAfterRemove(rows: ShareAdjustRow[], removedIndex: number): ShareAdjustRow[] {
  const next = rows.filter((_, i) => i !== removedIndex);
  if (next.length === 1) {
    return [{ ...next[0], sharePct: 100 }];
  }
  return rebalanceTo100(next);
}

/** Default share for a newly added leg. */
export function defaultShareForNewLeg(rows: ShareAdjustRow[]): number {
  if (rows.length === 0) return 100;
  const movable = rows.filter((r) => !r.shareFixed);
  if (movable.length === 0) return 0;
  if (movable.length === 1 && !movable[0].shareFixed) {
    return 0;
  }
  return 0;
}
