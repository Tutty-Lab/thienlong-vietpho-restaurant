// ============================================================================
// Monats-Soll eines Azubis. Wird aus den Wochenstunden des Chefs abgeleitet;
// 24 h in der Berufsschulzeit und 38,5 h außerhalb bleiben harte Obergrenzen.
// ============================================================================

import {
  AZUBI_HOURS_IN_TERM,
  AZUBI_HOURS_OUT_OF_TERM,
  type AzubiConfig,
  type Employee,
} from "../types";

/** Fuer die monatliche Sollzeit gilt ein fester Abrechnungsmonat mit 4 Wochen. */
export const AZUBI_MONTHLY_WEEKS = 4;

export const DEFAULT_AZUBI_CONFIG: AzubiConfig = {
  inSchoolTerm: true,
  schoolDays: ["monday", "tuesday"],
  weeklyHoursInTerm: AZUBI_HOURS_IN_TERM,
  weeklyHoursOutOfTerm: AZUBI_HOURS_OUT_OF_TERM,
};

function normalizeWeeklyHours(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(0, Math.round((value ?? fallback) * 2) / 2);
}

function normalizedAzubiConfig(cfg: AzubiConfig | undefined): AzubiConfig {
  const source = cfg ?? DEFAULT_AZUBI_CONFIG;
  return {
    inSchoolTerm: source.inSchoolTerm,
    schoolDays: [...source.schoolDays],
    weeklyHoursInTerm: normalizeWeeklyHours(
      source.weeklyHoursInTerm,
      AZUBI_HOURS_IN_TERM,
    ),
    weeklyHoursOutOfTerm: normalizeWeeklyHours(
      source.weeklyHoursOutOfTerm,
      AZUBI_HOURS_OUT_OF_TERM,
    ),
  };
}

/** Neue Kopie, damit UI-Aenderungen nie die gemeinsame Vorgabe mutieren. */
export function defaultAzubiConfig(): AzubiConfig {
  return normalizedAzubiConfig(DEFAULT_AZUBI_CONFIG);
}

export function azubiConfigOf(cfg: AzubiConfig | undefined): AzubiConfig {
  return normalizedAzubiConfig(cfg);
}

export function azubiWeeklyMaximum(inSchoolTerm: boolean): number {
  return inSchoolTerm ? AZUBI_HOURS_IN_TERM : AZUBI_HOURS_OUT_OF_TERM;
}

/** Vom Chef eingestellte Wochenstunden, noch ohne Anwendung der Obergrenze. */
export function azubiConfiguredWeeklyHours(
  cfg: AzubiConfig | undefined,
  inSchoolTerm = azubiConfigOf(cfg).inSchoolTerm,
): number {
  const normalized = azubiConfigOf(cfg);
  return inSchoolTerm
    ? (normalized.weeklyHoursInTerm ?? AZUBI_HOURS_IN_TERM)
    : (normalized.weeklyHoursOutOfTerm ?? AZUBI_HOURS_OUT_OF_TERM);
}

/** Tatsächlich verwendete Wochenstunden: Einstellung, begrenzt auf das Maximum. */
export function azubiEffectiveWeeklyHours(
  cfg: AzubiConfig | undefined,
  inSchoolTerm = azubiConfigOf(cfg).inSchoolTerm,
): number {
  return Math.min(
    azubiConfiguredWeeklyHours(cfg, inSchoolTerm),
    azubiWeeklyMaximum(inSchoolTerm),
  );
}

export function azubiExceedsWeeklyMaximum(
  cfg: AzubiConfig | undefined,
  inSchoolTerm = azubiConfigOf(cfg).inSchoolTerm,
): boolean {
  return azubiConfiguredWeeklyHours(cfg, inSchoolTerm) > azubiWeeklyMaximum(inSchoolTerm);
}

/** Effektive Wochenstunden der aktuell gewählten Schulzeit. */
export function azubiWeeklyHours(cfg: AzubiConfig | undefined): number {
  return azubiEffectiveWeeklyHours(cfg);
}

/**
 * Monats-Soll in Minuten. Der Abrechnungsmonat hat immer vier Wochen, damit
 * Monate, die fünf Kalenderwochen berühren, nicht auf 112 h oder 120 h steigen.
 */
export function azubiMonthlyMinutes(
  cfg: AzubiConfig | undefined,
  _year: number,
  _month: number,
): number {
  const normalized = azubiConfigOf(cfg);
  return Math.round(azubiWeeklyHours(normalized) * AZUBI_MONTHLY_WEEKS * 60);
}

/** Soll eines Mitarbeiters – bei Azubis immer gerechnet, sonst wie eingetragen. */
export function effectiveTargetMinutes(
  employee: Employee,
  year: number,
  month: number,
): number {
  if (employee.employmentType !== "AZUBI") return employee.targetMinutes;
  return azubiMonthlyMinutes(employee.azubi, year, month);
}

/** Fuegt fehlende Azubi-Vorgaben ein und synchronisiert das Monats-Soll. */
export function withAutomaticAzubiTarget(
  employee: Employee,
  year: number,
  month: number,
): Employee {
  if (employee.employmentType !== "AZUBI") return employee;

  const azubi = azubiConfigOf(employee.azubi);
  const targetMinutes = azubiMonthlyMinutes(azubi, year, month);
  const configChanged =
    !employee.azubi ||
    employee.azubi.weeklyHoursInTerm !== azubi.weeklyHoursInTerm ||
    employee.azubi.weeklyHoursOutOfTerm !== azubi.weeklyHoursOutOfTerm;
  if (!configChanged && employee.targetMinutes === targetMinutes) return employee;

  return { ...employee, azubi, targetMinutes };
}
