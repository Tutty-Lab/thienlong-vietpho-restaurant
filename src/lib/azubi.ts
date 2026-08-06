// ============================================================================
// Azubi-Sollzeit und Migration alter Wochenstunden-Einstellungen.
// In der Schulzeit setzt der Chef das Soll je Monat; ausserhalb gilt ein
// allgemeines Monatssoll. Alte Schultage bleiben nur fuer die Migration.
// ============================================================================

import {
  AZUBI_HOURS_OUT_OF_TERM,
  AZUBI_MONTHLY_WARNING_HOURS,
  type AzubiConfig,
  type Employee,
} from "../types";

/** Standard aus der bisherigen Vorgabe 38,5 h/Woche mal vier Wochen. */
export const DEFAULT_AZUBI_MONTHLY_HOURS_OUT_OF_TERM = AZUBI_HOURS_OUT_OF_TERM * 4;

export const DEFAULT_AZUBI_CONFIG: AzubiConfig = {
  inSchoolTerm: true,
  schoolDays: [],
  monthlyHoursOutOfTerm: DEFAULT_AZUBI_MONTHLY_HOURS_OUT_OF_TERM,
};

export type AzubiMonthMode = "school" | "mixed" | "work";
export type AzubiTimesheetMode = "off" | "work" | "mixed";

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_KEY_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

function normalizeIsoDate(value: string | undefined): string | undefined {
  return value && ISO_DATE_PATTERN.test(value) ? value : undefined;
}

function normalizeHours(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(0, Math.round((value ?? fallback) * 2) / 2);
}

function normalizeMonthlyHoursByMonth(
  values: Record<string, number> | undefined,
): Record<string, number> | undefined {
  if (!values) return undefined;

  const normalized = Object.entries(values)
    .filter(([key, value]) => MONTH_KEY_PATTERN.test(key) && Number.isFinite(value))
    .map(([key, value]) => [key, normalizeHours(value, 0)] as const)
    .sort(([left], [right]) => left.localeCompare(right));

  return normalized.length > 0 ? Object.fromEntries(normalized) : undefined;
}

function monthlyHoursMapsEqual(
  left: Record<string, number> | undefined,
  right: Record<string, number> | undefined,
): boolean {
  const leftEntries = Object.entries(normalizeMonthlyHoursByMonth(left) ?? {});
  const rightEntries = Object.entries(normalizeMonthlyHoursByMonth(right) ?? {});
  return (
    leftEntries.length === rightEntries.length &&
    leftEntries.every(
      ([key, value], index) =>
        rightEntries[index]?.[0] === key && rightEntries[index]?.[1] === value,
    )
  );
}

function monthlyHoursFrom(source: AzubiConfig): number {
  if (Number.isFinite(source.monthlyHoursOutOfTerm)) {
    return normalizeHours(
      source.monthlyHoursOutOfTerm,
      DEFAULT_AZUBI_MONTHLY_HOURS_OUT_OF_TERM,
    );
  }
  if (Number.isFinite(source.weeklyHoursOutOfTerm)) {
    return normalizeHours(
      (source.weeklyHoursOutOfTerm ?? AZUBI_HOURS_OUT_OF_TERM) * 4,
      DEFAULT_AZUBI_MONTHLY_HOURS_OUT_OF_TERM,
    );
  }
  return DEFAULT_AZUBI_MONTHLY_HOURS_OUT_OF_TERM;
}

function normalizedAzubiConfig(cfg: AzubiConfig | undefined): AzubiConfig {
  const source = cfg ?? DEFAULT_AZUBI_CONFIG;
  const rawStart = normalizeIsoDate(source.schoolTermStart);
  const rawEnd = normalizeIsoDate(source.schoolTermEnd);
  const schoolTermStart = rawStart && rawEnd && rawStart > rawEnd ? rawEnd : rawStart;
  const schoolTermEnd = rawStart && rawEnd && rawStart > rawEnd ? rawStart : rawEnd;
  const monthlyHoursByMonth = normalizeMonthlyHoursByMonth(source.monthlyHoursByMonth);

  return {
    inSchoolTerm: source.inSchoolTerm,
    ...(schoolTermStart && { schoolTermStart }),
    ...(schoolTermEnd && { schoolTermEnd }),
    schoolDays: [...(source.schoolDays ?? [])],
    monthlyHoursOutOfTerm: monthlyHoursFrom(source),
    ...(monthlyHoursByMonth && { monthlyHoursByMonth }),
  };
}

/** Neue Kopie, damit UI-Aenderungen nie die gemeinsame Vorgabe mutieren. */
export function defaultAzubiConfig(): AzubiConfig {
  return normalizedAzubiConfig(DEFAULT_AZUBI_CONFIG);
}

export function azubiConfigOf(cfg: AzubiConfig | undefined): AzubiConfig {
  return normalizedAzubiConfig(cfg);
}

/** Vom Chef gesetztes Monatssoll ausserhalb der Schulzeit. */
export function azubiMonthlyHoursOutOfTerm(cfg: AzubiConfig | undefined): number {
  return azubiConfigOf(cfg).monthlyHoursOutOfTerm ?? DEFAULT_AZUBI_MONTHLY_HOURS_OUT_OF_TERM;
}

/** Konfigurierter Zeitraum; null ohne konkrete Daten (Altdaten = ganzer Monat). */
export function azubiSchoolTermRange(
  cfg: AzubiConfig | undefined,
): { start: string; end: string } | null {
  const normalized = azubiConfigOf(cfg);
  if (!normalized.inSchoolTerm) return null;

  if (normalized.schoolTermStart && normalized.schoolTermEnd) {
    return { start: normalized.schoolTermStart, end: normalized.schoolTermEnd };
  }
  if (normalized.schoolTermStart) {
    return { start: normalized.schoolTermStart, end: normalized.schoolTermStart };
  }
  if (normalized.schoolTermEnd) {
    return { start: normalized.schoolTermEnd, end: normalized.schoolTermEnd };
  }
  return null;
}

/** true = das Datum liegt innerhalb des konfigurierten Schulzeitraums. */
export function isAzubiSchoolTermDate(
  cfg: AzubiConfig | undefined,
  isoDate: string,
): boolean {
  const normalized = azubiConfigOf(cfg);
  if (!normalized.inSchoolTerm) return false;

  const range = azubiSchoolTermRange(normalized);
  if (!range) return true;
  return isoDate >= range.start && isoDate <= range.end;
}

/** @deprecated Schultage blockieren keine Arbeitstage mehr. */
export function isAzubiSchoolDate(
  _cfg: AzubiConfig | undefined,
  _isoDate: string,
): boolean {
  return false;
}

function isoDate(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function azubiSchoolTermDaysInMonth(
  cfg: AzubiConfig | undefined,
  year: number,
  month: number,
): number {
  const totalDays = new Date(year, month, 0).getDate();
  let termDays = 0;
  for (let day = 1; day <= totalDays; day += 1) {
    if (isAzubiSchoolTermDate(cfg, isoDate(year, month, day))) termDays += 1;
  }
  return termDays;
}

/** @deprecated Name aus der ersten Zeitraum-Version. */
export const azubiSchoolDaysInMonth = azubiSchoolTermDaysInMonth;

export function azubiMonthMode(
  cfg: AzubiConfig | undefined,
  year: number,
  month: number,
): AzubiMonthMode {
  const totalDays = new Date(year, month, 0).getDate();
  const termDays = azubiSchoolTermDaysInMonth(cfg, year, month);
  if (termDays === 0) return "work";
  if (termDays === totalDays) return "school";
  return "mixed";
}

/** Stabiler Schluessel fuer eine monatsspezifische Azubi-Vorgabe. */
export function azubiMonthKey(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, "0")}`;
}

/** Manuell gesetzte Stunden eines Monats im Schulzeitraum. */
export function azubiMonthlyHoursOverride(
  cfg: AzubiConfig | undefined,
  year: number,
  month: number,
): number | undefined {
  return azubiConfigOf(cfg).monthlyHoursByMonth?.[azubiMonthKey(year, month)];
}

/**
 * Wirksames Monatssoll:
 * - Monat im Schulzeitraum: exakte Eingabe fuer yyyy-MM, bis dahin 0 h
 * - Arbeitsmonat: allgemeines Monatssoll ausserhalb der Schulzeit
 */
export function azubiMonthlyHoursForMonth(
  cfg: AzubiConfig | undefined,
  year: number,
  month: number,
): number {
  const normalized = azubiConfigOf(cfg);
  const mode = azubiMonthMode(normalized, year, month);
  if (mode !== "work") {
    return normalized.monthlyHoursByMonth?.[azubiMonthKey(year, month)] ?? 0;
  }
  return azubiMonthlyHoursOutOfTerm(normalized);
}

/** Status shown on the printed/exported timesheet for the selected month. */
export function azubiTimesheetMode(
  cfg: AzubiConfig | undefined,
  year: number,
  month: number,
): AzubiTimesheetMode {
  if (azubiMonthlyHoursForMonth(cfg, year, month) === 0) return "off";
  return azubiMonthMode(cfg, year, month) === "work" ? "work" : "mixed";
}

/** 172 h und mehr werden nur markiert, nie gekappt oder deaktiviert. */
export function azubiMonthlyHoursNeedWarning(
  cfg: AzubiConfig | undefined,
  year?: number,
  month?: number,
): boolean {
  const hours =
    year !== undefined && month !== undefined
      ? azubiMonthlyHoursForMonth(cfg, year, month)
      : azubiMonthlyHoursOutOfTerm(cfg);
  return hours >= AZUBI_MONTHLY_WARNING_HOURS;
}

/** Monatssoll in Minuten, ohne automatische anteilige Berechnung. */
export function azubiMonthlyMinutes(
  cfg: AzubiConfig | undefined,
  year: number,
  month: number,
): number {
  return Math.round(azubiMonthlyHoursForMonth(cfg, year, month) * 60);
}

/** Soll eines Mitarbeiters - bei Azubis aus der Konfiguration, sonst eingetragen. */
export function effectiveTargetMinutes(
  employee: Employee,
  year: number,
  month: number,
): number {
  if (employee.employmentType !== "AZUBI") return employee.targetMinutes;
  return azubiMonthlyMinutes(employee.azubi, year, month);
}

/** Migriert Azubi-Altdaten und synchronisiert das wirksame Monatssoll. */
export function withAutomaticAzubiTarget(
  employee: Employee,
  year: number,
  month: number,
): Employee {
  if (employee.employmentType !== "AZUBI") return employee;

  const azubi = azubiConfigOf(employee.azubi);
  const targetMinutes = azubiMonthlyMinutes(azubi, year, month);
  const oldConfig = employee.azubi;
  const configChanged =
    !oldConfig ||
    oldConfig.schoolTermStart !== azubi.schoolTermStart ||
    oldConfig.schoolTermEnd !== azubi.schoolTermEnd ||
    oldConfig.monthlyHoursOutOfTerm !== azubi.monthlyHoursOutOfTerm ||
    !monthlyHoursMapsEqual(oldConfig.monthlyHoursByMonth, azubi.monthlyHoursByMonth) ||
    oldConfig.weeklyHoursInTerm !== undefined ||
    oldConfig.weeklyHoursOutOfTerm !== undefined;
  if (!configChanged && employee.targetMinutes === targetMinutes) return employee;

  return { ...employee, azubi, targetMinutes };
}
