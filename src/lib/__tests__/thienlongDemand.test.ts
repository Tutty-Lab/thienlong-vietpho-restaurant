import { describe, expect, it } from "vitest";
import {
  THIENLONG_REFERENCE_INVOICES,
  clipDemandIntervals,
  demandCoverageGain,
  demandCoverageGap,
  thienlongDemandHours,
  thienlongDemandIntervals,
  thienlongDemandWeight,
  thienlongLateShiftRatio,
} from "../thienlongDemand";
import type { Shift } from "../../types";

function shift(id: string, startMinutes: number, endMinutes: number): Shift {
  return {
    id,
    employeeId: id,
    date: "2026-08-03",
    startMinutes,
    endMinutes,
    pauseMinutes: 0,
    paidMinutes: endMinutes - startMinutes,
    shiftType: "CUSTOM",
    generated: true,
  };
}

describe("Thienlong role demand profile", () => {
  it("uses the customer-provided weekday Kitchen/Service person-hours", () => {
    expect(thienlongDemandHours("monday", "KITCHEN")).toBe(26);
    expect(thienlongDemandHours("monday", "SERVICE")).toBe(15.5);
    expect(thienlongDemandHours("saturday", "SERVICE")).toBe(17.5);

    expect(thienlongDemandIntervals("monday", "KITCHEN")).toEqual([
      { startMinutes: 10 * 60 + 30, endMinutes: 12 * 60, personMinutes: 3 * 60 },
      { startMinutes: 12 * 60, endMinutes: 14 * 60, personMinutes: 7 * 60 },
      { startMinutes: 14 * 60, endMinutes: 15 * 60, personMinutes: 2 * 60 },
      { startMinutes: 16 * 60 + 30, endMinutes: 18 * 60, personMinutes: 3 * 60 },
      { startMinutes: 18 * 60, endMinutes: 20 * 60, personMinutes: 7 * 60 },
      { startMinutes: 20 * 60, endMinutes: 22 * 60, personMinutes: 4 * 60 },
    ]);
  });

  it("keeps Friday and Saturday equally busy while Sunday remains lower", () => {
    expect(thienlongDemandWeight("friday")).toBe(thienlongDemandWeight("saturday"));
    expect(thienlongLateShiftRatio("friday")).toBe(thienlongLateShiftRatio("saturday"));
    expect(thienlongDemandWeight("sunday")).toBeLessThan(thienlongDemandWeight("friday"));
    expect(thienlongLateShiftRatio("sunday")).toBeLessThan(thienlongLateShiftRatio("friday"));
  });

  it("records 150 Rechnungen as the profile calibration reference", () => {
    expect(THIENLONG_REFERENCE_INVOICES).toBe(150);
  });

  it("prefers the shift that fills the currently uncovered role intervals", () => {
    const demand = thienlongDemandIntervals("monday", "SERVICE");
    const early = shift("early", 10 * 60 + 30, 15 * 60);
    const late = shift("late", 16 * 60 + 30, 22 * 60);

    expect(demandCoverageGain(late, [], demand)).toBeGreaterThan(
      demandCoverageGain(early, [], demand),
    );
    expect(demandCoverageGain(early, [late], demand)).toBeGreaterThan(
      demandCoverageGain(late, [late], demand),
    );
  });

  it("reports the remaining person-minutes after role shifts are assigned", () => {
    const demand = [{ startMinutes: 18 * 60, endMinutes: 20 * 60, personMinutes: 2 * 60 }];

    expect(demandCoverageGap([shift("one", 18 * 60, 19 * 60)], demand)).toBe(60);
  });

  it("clips demand outside the configured work window without changing its density", () => {
    const clipped = clipDemandIntervals(
      thienlongDemandIntervals("saturday", "SERVICE"),
      [{ startMinutes: 11 * 60 + 30, endMinutes: 22 * 60 }],
    );

    expect(clipped[0]).toEqual({
      startMinutes: 11 * 60 + 30,
      endMinutes: 12 * 60,
      personMinutes: 30,
    });
    expect(clipped.reduce((total, demand) => total + demand.personMinutes, 0)).toBe(16.5 * 60);
  });
});
