import type { WeekdayKey } from "./demand";

export const VIETPHO_REFERENCE_INVOICES = 100;
export const VIETPHO_REFERENCE_TAX_INCLUDED = true;

export type VietphoDemandInterval = {
  startMinutes: number;
  endMinutes: number;
  personMinutes: number;
};

export type VietphoPeakInterval = {
  startMinutes: number;
  endMinutes: number;
  minStaff: number;
};

type ReferenceInterval = {
  startMinutes: number;
  endMinutes: number;
  staff: number;
};

const interval = (startMinutes: number, endMinutes: number, staff: number): ReferenceInterval => ({
  startMinutes,
  endMinutes,
  staff,
});

const WEEKDAY: readonly ReferenceInterval[] = [
  interval(11 * 60, 12 * 60 + 30, 1),
  interval(12 * 60 + 30, 13 * 60, 2),
  interval(13 * 60, 15 * 60, 1),
  interval(17 * 60, 18 * 60, 1),
  interval(18 * 60, 20 * 60, 2),
  interval(20 * 60, 22 * 60, 1),
];

const CONTINUOUS_DAY: readonly ReferenceInterval[] = [
  interval(11 * 60, 12 * 60 + 30, 1),
  interval(12 * 60 + 30, 13 * 60, 2),
  interval(13 * 60, 18 * 60, 1),
  interval(18 * 60, 20 * 60, 2),
  interval(20 * 60, 22 * 60, 1),
];

const WEEKEND: readonly ReferenceInterval[] = [
  interval(12 * 60, 12 * 60 + 30, 1),
  interval(12 * 60 + 30, 13 * 60, 2),
  interval(13 * 60, 18 * 60, 1),
  interval(18 * 60, 20 * 60, 2),
  interval(20 * 60, 22 * 60, 1),
];

const PEAKS: readonly VietphoPeakInterval[] = [
  { startMinutes: 12 * 60 + 30, endMinutes: 13 * 60, minStaff: 2 },
  { startMinutes: 18 * 60, endMinutes: 20 * 60, minStaff: 2 },
];

function profileOf(weekday: WeekdayKey, isHoliday: boolean): readonly ReferenceInterval[] {
  if (isHoliday || weekday === "saturday" || weekday === "sunday") return WEEKEND;
  if (weekday === "friday") return CONTINUOUS_DAY;
  return WEEKDAY;
}

function referencePersonMinutes(item: ReferenceInterval): number {
  return (item.endMinutes - item.startMinutes) * item.staff;
}

export function vietphoDemandIntervals(
  weekday: WeekdayKey,
  totalTargetMinutes: number,
  isHoliday = false,
): VietphoDemandInterval[] {
  const profile = profileOf(weekday, isHoliday);
  const referenceTotal = profile.reduce(
    (total, item) => total + referencePersonMinutes(item),
    0,
  );
  return profile.map((item) => ({
    startMinutes: item.startMinutes,
    endMinutes: item.endMinutes,
    personMinutes:
      referenceTotal > 0
        ? Math.max(0, totalTargetMinutes) * referencePersonMinutes(item) / referenceTotal
        : 0,
  }));
}

export function vietphoPeakIntervals(): VietphoPeakInterval[] {
  return PEAKS.map((peak) => ({ ...peak }));
}

/** Busy days are only about 20% above the quiet weekday baseline. */
export function vietphoDemandWeight(weekday: WeekdayKey, isHoliday = false): number {
  if (isHoliday || weekday === "friday" || weekday === "saturday") return 1.2;
  if (weekday === "sunday") return 1.05;
  return 1;
}

export function vietphoLateShiftRatio(weekday: WeekdayKey, isHoliday = false): number {
  if (isHoliday || weekday === "friday" || weekday === "saturday") return 0.65;
  if (weekday === "sunday") return 0.63;
  return 0.61;
}
