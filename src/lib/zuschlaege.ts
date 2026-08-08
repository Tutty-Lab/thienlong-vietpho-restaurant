import type { Shift, SurchargeConfig } from "../types";
import { parseIsoDate, weekdayKeyOf } from "./demand";

const AFTER_20 = 20 * 60;

export const DEFAULT_SURCHARGE_CONFIG: SurchargeConfig = {
  after20Percent: 0,
  sundayPercent: 0,
};

function validPercent(value: number | undefined): number {
  return Number.isFinite(value) ? Math.max(0, value ?? 0) : 0;
}

export function normalizeSurchargeConfig(
  config?: Partial<SurchargeConfig>,
): SurchargeConfig {
  return {
    after20Percent: validPercent(config?.after20Percent),
    sundayPercent: validPercent(config?.sundayPercent),
  };
}

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

export type ZuschlagCalculation = ZuschlagTotals &
  SurchargeConfig & {
    after20BonusMinutes: number;
    sundayBonusMinutes: number;
    totalBonusMinutes: number;
  };

/**
 * Converts surcharge percentages into bonus-equivalent minutes. A Sunday hour
 * after 20:00 receives both bonuses; each result is rounded to a full minute.
 */
export function calculateZuschlaege(
  shifts: readonly Shift[],
  config?: Partial<SurchargeConfig>,
): ZuschlagCalculation {
  const totals = zuschlagTotals(shifts);
  const normalized = normalizeSurchargeConfig(config);
  const after20BonusMinutes = Math.round(
    totals.after20Minutes * normalized.after20Percent / 100,
  );
  const sundayBonusMinutes = Math.round(
    totals.sundayMinutes * normalized.sundayPercent / 100,
  );

  return {
    ...totals,
    ...normalized,
    after20BonusMinutes,
    sundayBonusMinutes,
    totalBonusMinutes: after20BonusMinutes + sundayBonusMinutes,
  };
}
