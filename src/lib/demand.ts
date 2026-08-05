// ============================================================================
// Kundennachfrage-Konzept: Tagesgewichte + gewünschte Spätschicht-Anteile.
// ============================================================================

import { eachDayOfInterval, endOfMonth, format, getDay, startOfMonth } from "date-fns";

export type WeekdayKey =
  | "monday"
  | "tuesday"
  | "wednesday"
  | "thursday"
  | "friday"
  | "saturday"
  | "sunday";

/**
 * Nachfrage-Gewichte je Wochentag (keine Mitarbeiterzahlen!).
 * Laut Chef sind genau Fr/Sa/So die vollen Tage – etwa doppelt so stark wie
 * ein ruhiger Wochentag. Mo–Do liegen deshalb alle bei 1,0; ein früher
 * angenommener Donnerstags-Zuschlag war nicht belegt und wurde entfernt.
 */
export const DAY_WEIGHTS: Record<WeekdayKey, number> = {
  monday: 1.0,
  tuesday: 1.0,
  wednesday: 1.0,
  thursday: 1.0,
  friday: 1.8,
  saturday: 2.0,
  sunday: 1.6,
};

/**
 * Gewünschter Anteil an Spätschicht-Stunden je Wochentag.
 * Basis laut Chef: der Abend macht rund 2/3 des Umsatzes aus -> 0,67 an den
 * ruhigen Tagen. Fr/Sa/So liegen darüber, weil dort abends noch mehr los ist.
 */
export const LATE_SHIFT_RATIOS: Record<WeekdayKey, number> = {
  monday: 0.67,
  tuesday: 0.67,
  wednesday: 0.67,
  thursday: 0.67,
  friday: 0.72,
  saturday: 0.74,
  sunday: 0.85,
};

/** date-fns getDay(): 0=So ... 6=Sa  ->  WeekdayKey. */
const WEEKDAY_BY_GETDAY: Record<number, WeekdayKey> = {
  0: "sunday",
  1: "monday",
  2: "tuesday",
  3: "wednesday",
  4: "thursday",
  5: "friday",
  6: "saturday",
};

export const WEEKDAY_LABELS_DE: Record<WeekdayKey, string> = {
  monday: "Montag",
  tuesday: "Dienstag",
  wednesday: "Mittwoch",
  thursday: "Donnerstag",
  friday: "Freitag",
  saturday: "Samstag",
  sunday: "Sonntag",
};

export const WEEKDAY_SHORT_DE: Record<WeekdayKey, string> = {
  monday: "Mo",
  tuesday: "Di",
  wednesday: "Mi",
  thursday: "Do",
  friday: "Fr",
  saturday: "Sa",
  sunday: "So",
};

// Vietnamesische Wochentage – für die App-Oberfläche.
export const WEEKDAY_LABELS_VI: Record<WeekdayKey, string> = {
  monday: "Thứ Hai",
  tuesday: "Thứ Ba",
  wednesday: "Thứ Tư",
  thursday: "Thứ Năm",
  friday: "Thứ Sáu",
  saturday: "Thứ Bảy",
  sunday: "Chủ Nhật",
};

export const WEEKDAY_SHORT_VI: Record<WeekdayKey, string> = {
  monday: "T2",
  tuesday: "T3",
  wednesday: "T4",
  thursday: "T5",
  friday: "T6",
  saturday: "T7",
  sunday: "CN",
};

export function weekdayKeyOf(date: Date): WeekdayKey {
  return WEEKDAY_BY_GETDAY[getDay(date)];
}

/** Alle Kalendertage eines Monats als ISO-Strings "yyyy-MM-dd". month ist 1-basiert. */
export function datesOfMonth(year: number, month: number): string[] {
  const first = startOfMonth(new Date(year, month - 1, 1));
  const last = endOfMonth(first);
  return eachDayOfInterval({ start: first, end: last }).map((d) => format(d, "yyyy-MM-dd"));
}

export function dayWeightOf(isoDate: string): number {
  return DAY_WEIGHTS[weekdayKeyOf(parseIsoDate(isoDate))];
}

export function lateRatioOf(isoDate: string): number {
  return LATE_SHIFT_RATIOS[weekdayKeyOf(parseIsoDate(isoDate))];
}

/** ISO "yyyy-MM-dd" -> lokales Date (ohne Zeitzonen-Verschiebung). */
export function parseIsoDate(isoDate: string): Date {
  const [y, m, d] = isoDate.split("-").map(Number);
  return new Date(y, m - 1, d);
}
