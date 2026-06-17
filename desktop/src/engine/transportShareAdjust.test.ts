import { describe, expect, it } from "vitest";
import { adjustTransportShares } from "./transportShareAdjust";

describe("adjustTransportShares", () => {
  it("keeps fixed rows when a movable share changes", () => {
    const rows = [
      { sharePct: 40, shareFixed: true },
      { sharePct: 30, shareFixed: false },
      { sharePct: 30, shareFixed: false }
    ];
    const next = adjustTransportShares(rows, 1, 50);
    expect(next[0].sharePct).toBe(40);
    expect(next[1].sharePct).toBe(50);
    expect(next[2].sharePct).toBe(10);
    expect(next.reduce((s, r) => s + r.sharePct, 0)).toBeCloseTo(100, 1);
  });

  it("only updates the edited row when it is fixed", () => {
    const rows = [
      { sharePct: 60, shareFixed: true },
      { sharePct: 40, shareFixed: false }
    ];
    const next = adjustTransportShares(rows, 0, 70);
    expect(next[0].sharePct).toBe(70);
    expect(next[1].sharePct).toBe(40);
  });

  it("scales other movable rows proportionally", () => {
    const rows = [
      { sharePct: 50, shareFixed: false },
      { sharePct: 30, shareFixed: false },
      { sharePct: 20, shareFixed: false }
    ];
    const next = adjustTransportShares(rows, 0, 60);
    expect(next[0].sharePct).toBe(60);
    expect(next[1].sharePct).toBeCloseTo(24, 0);
    expect(next[2].sharePct).toBeCloseTo(16, 0);
    expect(next.reduce((s, r) => s + r.sharePct, 0)).toBeCloseTo(100, 1);
  });
});
