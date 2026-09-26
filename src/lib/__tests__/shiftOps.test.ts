import { describe, expect, it } from "vitest";
import type { Shift } from "../../types";
import { createManualShift, piecesError, updateShiftPieces } from "../shiftOps";

const split: Shift = {
  id: "s", employeeId: "e", date: "2026-09-01", startMinutes: 11 * 60, endMinutes: 22 * 60,
  pauseMinutes: 0, paidMinutes: 8 * 60, shiftType: "CUSTOM", generated: true,
  segments: [
    { startMinutes: 11 * 60, endMinutes: 14 * 60 },
    { startMinutes: 17 * 60, endMinutes: 22 * 60 },
  ],
};

describe("Sửa ca gãy (2 ca)", () => {
  it("keeps a split shift split when edited: paid = sum of both pieces, no pause", () => {
    const next = updateShiftPieces(split, [
      { startMinutes: 11 * 60, endMinutes: 15 * 60 },
      { startMinutes: 17 * 60, endMinutes: 22 * 60 },
    ], 30);
    expect(next.segments).toHaveLength(2);
    expect(next.paidMinutes).toBe(9 * 60);
    expect(next.pauseMinutes).toBe(0);
    expect([next.startMinutes, next.endMinutes]).toEqual([11 * 60, 22 * 60]);
    expect(next.generated).toBe(false);
  });

  it("turns into a single shift with pause when ca 2 is removed", () => {
    const next = updateShiftPieces(split, [{ startMinutes: 11 * 60, endMinutes: 18 * 60 }], 30);
    expect(next.segments).toBeUndefined();
    expect(next.paidMinutes).toBe(6.5 * 60);
    expect(next.pauseMinutes).toBe(30);
  });

  it("creates a new split shift", () => {
    const created = createManualShift("e", "2026-09-02", [
      { startMinutes: 17 * 60, endMinutes: 22 * 60 },
      { startMinutes: 11 * 60, endMinutes: 14 * 60 },
    ], 0);
    expect(created.segments!.map((g) => g.startMinutes)).toEqual([11 * 60, 17 * 60]);
    expect(created.paidMinutes).toBe(8 * 60);
  });

  it("rejects overlapping or reversed pieces", () => {
    expect(piecesError([{ startMinutes: 11 * 60, endMinutes: 15 * 60 }, { startMinutes: 14 * 60, endMinutes: 20 * 60 }])).not.toBeNull();
    expect(piecesError([{ startMinutes: 15 * 60, endMinutes: 11 * 60 }])).not.toBeNull();
    expect(piecesError([{ startMinutes: 11 * 60, endMinutes: 14 * 60 }, { startMinutes: 17 * 60, endMinutes: 22 * 60 }])).toBeNull();
  });
});
