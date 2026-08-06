// ============================================================================
// Azubi-Sollzeit und Migration alter Wochenstunden-Einstellungen.
// In der Schulzeit gilt 0 h; ausserhalb setzt der Chef das Monatssoll selbst.
// ============================================================================

import {
  AZUBI_HOURS_IN_TERM,
  AZUBI_HOURS_OUT_OF_TERM,
  AZUBI_MONTHLY_WARNING_HOURS,
  type AzubiConfig,
  type Employee,
} from "../types";

/** Standard aus der bisherigen Vorgabe 38,5 h/Woche mal vier Wochen. */
export const DEFAULT_AZUBI_MONTHLY_HOURS_OUT_OF_TERM = AZUBI_HOURS_OUT_OF_TERM * 4;

export const DEFAULT_AZUBI_CONFIG: AzubiConfig = {
  inSchoolTerm: true,
  schoolDays: ["monday", "tuesday"],
  monthlyHoursOutOfTerm: DEFAULT_AZUBI_MONTHLY_HOURS_OUT_OF_TERM,
};

function normalizeHours(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(0, Math.round((value ?? fallback) * 2) / 2);
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
  return {
    inSchoolTerm: source.inSchoolTerm,
    schoolDays: [...source.schoolDays],
    monthlyHoursOutOfTerm: monthlyHoursFrom(source),
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

/** 172 h und mehr werden nur markiert, nie gekappt oder deaktiviert. */
export function azubiMonthlyHoursNeedWarning(cfg: AzubiConfig | undefined): boolean {
  return azubiMonthlyHoursOutOfTerm(cfg) >= AZUBI_MONTHLY_WARNING_HOURS;
}

/** Woechentliche Planungsgrenze: 0 h in der Schulzeit, sonst 38,5 h. */
export function azubiWeeklyHours(cfg: AzubiConfig | undefined): number {
  return azubiConfigOf(cfg).inSchoolTerm ? AZUBI_HOURS_IN_TERM : AZUBI_HOURS_OUT_OF_TERM;
}

/** Monatssoll in Minuten; Jahr und Monat bleiben Teil der stabilen Schnittstelle. */
export function azubiMonthlyMinutes(
  cfg: AzubiConfig | undefined,
  _year: number,
  _month: number,
): number {
  const normalized = azubiConfigOf(cfg);
  const hours = normalized.inSchoolTerm ? 0 : azubiMonthlyHoursOutOfTerm(normalized);
  return Math.round(hours * 60);
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
    oldConfig.monthlyHoursOutOfTerm !== azubi.monthlyHoursOutOfTerm ||
    oldConfig.weeklyHoursInTerm !== undefined ||
    oldConfig.weeklyHoursOutOfTerm !== undefined;
  if (!configChanged && employee.targetMinutes === targetMinutes) return employee;

  return { ...employee, azubi, targetMinutes };
}
