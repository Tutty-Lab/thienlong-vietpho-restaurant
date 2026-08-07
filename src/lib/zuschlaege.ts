import type { Shift } from "../types";
import { parseIsoDate, weekdayKeyOf } from "./demand";

const AFTER_20 = 20 * 60;

/**
 * Minutes present after 20:00. Normal shifts do not store the exact pause
 * position, so the result is capped by paid time; generated late shifts place
 * their pause before this surcharge window.
 */
export function shiftMinutesAfter20(shift: Shift): number {
  const segments = shift.segments ?? [
    { startMinutes: shift.startMinutes, endMinutes: shift.endMinutes },
  ];
  const after20 = segments.reduce(
    (total, segment) =>
      total + Math.max(0, segment.endMinutes - Math.max(AFTER_20, segment.startMinutes)),
    0,
  );
  return Math.min(shift.paidMinutes, after20);
}

export type ZuschlagTotals = {
  after20Minutes: number;
  sundayMinutes: number;
};

export function zuschlagTotals(shifts: readonly Shift[]): ZuschlagTotals {
  return shifts.reduce<ZuschlagTotals>(
    (totals, shift) => ({
      after20Minutes: totals.after20Minutes + shiftMinutesAfter20(shift),
      sundayMinutes:
        totals.sundayMinutes +
        (weekdayKeyOf(parseIsoDate(shift.date)) === "sunday" ? shift.paidMinutes : 0),
    }),
    { after20Minutes: 0, sundayMinutes: 0 },
  );
}
