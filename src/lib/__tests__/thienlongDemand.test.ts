import { describe, expect, it } from "vitest";
import {
  THIENLONG_REFERENCE_INVOICES,
  clipDemandIntervals,
  demandCoverageGain,
  demandCoverageGap,
  thienlongDemandIntervals,
  thienlongDemandShares,
  thienlongDemandWeight,
  thienlongLateShiftRatio,
  thienlongRoleShare,
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
  it("scales the sample ratios to the actual total hours of the selected day", () => {
    const total = (items: ReturnType<typeof thienlongDemandIntervals>) =>
      items.reduce((sum, item) => sum + item.personMinutes, 0);
    const kitchenAt20Hours = total(
      thienlongDemandIntervals("monday", "KITCHEN", 20 * 60),
    );
    const kitchenAt40Hours = total(
      thienlongDemandIntervals("monday", "KITCHEN", 40 * 60),
    );

    expect(kitchenAt40Hours).toBeCloseTo(kitchenAt20Hours * 2);
    expect(kitchenAt20Hours).toBeCloseTo(20 * 60 * (26 / 41.5));
    const serviceAt20Hours = total(
      thienlongDemandIntervals("monday", "SERVICE", 20 * 60),
    );
    expect(kitchenAt20Hours + serviceAt20Hours).toBeCloseTo(20 * 60);
  });

  it("converts the actual example schedule into ratios instead of fixed hours", () => {
    expect(thienlongRoleShare("monday", "KITCHEN")).toBeCloseTo(26 / 41.5);
    expect(thienlongRoleShare("monday", "SERVICE")).toBeCloseTo(15.5 / 41.5);
    expect(thienlongRoleShare("saturday", "KITCHEN")).toBeCloseTo(28 / 45.5);
    expect(thienlongRoleShare("sunday", "KITCHEN")).toBeCloseTo(28 / 45.5);
    expect(
      thienlongRoleShare("monday", "KITCHEN") +
        thienlongRoleShare("monday", "SERVICE"),
    ).toBeCloseTo(1);

    expect(thienlongDemandShares("monday", "KITCHEN")).toEqual([
      { startMinutes: 10 * 60 + 30, endMinutes: 12 * 60, share: 3 / 41.5 },
      { startMinutes: 12 * 60, endMinutes: 14 * 60, share: 7 / 41.5 },
      { startMinutes: 14 * 60, endMinutes: 15 * 60, share: 2 / 41.5 },
      { startMinutes: 16 * 60 + 30, endMinutes: 18 * 60, share: 3 / 41.5 },
      { startMinutes: 18 * 60, endMinutes: 20 * 60, share: 7 / 41.5 },
      { startMinutes: 20 * 60, endMinutes: 22 * 60, share: 4 / 41.5 },
    ]);
  });

  it("keeps Friday and Saturday busiest while Sunday is only slightly above weekdays", () => {
    expect(thienlongDemandWeight("friday")).toBe(thienlongDemandWeight("saturday"));
    expect(thienlongLateShiftRatio("friday")).toBe(thienlongLateShiftRatio("saturday"));
    expect(thienlongDemandWeight("sunday")).toBeGreaterThan(thienlongDemandWeight("monday"));
    expect(thienlongDemandWeight("sunday")).toBeLessThan(thienlongDemandWeight("friday"));
    expect(thienlongLateShiftRatio("sunday")).toBeGreaterThan(thienlongLateShiftRatio("monday"));
    expect(thienlongLateShiftRatio("sunday")).toBeLessThan(thienlongLateShiftRatio("friday"));
  });

  it("records 150 Rechnungen as the profile calibration reference", () => {
    expect(THIENLONG_REFERENCE_INVOICES).toBe(150);
  });

  it("prefers the shift that fills the currently uncovered role intervals", () => {
    const demand = thienlongDemandIntervals("monday", "SERVICE", 41.5 * 60);
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
      thienlongDemandIntervals("saturday", "SERVICE", 45.5 * 60),
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
