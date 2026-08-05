// ============================================================================
// Monats-Soll eines Azubis. Wird aus den Wochenstunden des Chefs abgeleitet;
// 24 h in der Berufsschulzeit und 38,5 h außerhalb bleiben harte Obergrenzen.
// ============================================================================

import {
  AZUBI_HOURS_IN_TERM,
  AZUBI_HOURS_OUT_OF_TERM,
  AZUBI_WORKDAYS_IN_TERM,
  type AzubiConfig,
  type Employee,
  type WeekdayName,
} from "../types";

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

const WEEKDAY_BY_JS_DAY: WeekdayName[] = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
];

/** Anteilige Schulzeit-Wochenstunden für die im Monat liegenden Arbeitstage. */
function azubiTermHoursInMonth(cfg: AzubiConfig, year: number, month: number): number {
  const eligibleDaysByWeek = new Map<string, number>();
  const schoolDays = new Set(cfg.schoolDays);
  const daysInMonth = new Date(year, month, 0).getDate();

  for (let day = 1; day <= daysInMonth; day += 1) {
    const date = new Date(year, month - 1, day);
    if (schoolDays.has(WEEKDAY_BY_JS_DAY[date.getDay()])) continue;

    const monday = new Date(date);
    monday.setDate(date.getDate() - ((date.getDay() + 6) % 7));
    const weekKey = `${monday.getFullYear()}-${monday.getMonth() + 1}-${monday.getDate()}`;
    eligibleDaysByWeek.set(weekKey, (eligibleDaysByWeek.get(weekKey) ?? 0) + 1);
  }

  const weeklyHours = azubiEffectiveWeeklyHours(cfg, true);
  let hours = 0;
  for (const eligibleDays of eligibleDaysByWeek.values()) {
    hours +=
      weeklyHours *
      (Math.min(eligibleDays, AZUBI_WORKDAYS_IN_TERM) / AZUBI_WORKDAYS_IN_TERM);
  }
  return hours;
}

/**
 * Monats-Soll in Minuten, auf eine halbe Stunde gerundet. In der Schulzeit
 * zählt jede volle Kalenderwoche mit drei Arbeitstagen voll; Randwochen zählen
 * nur anteilig nach den tatsächlich im Monat liegenden, schulfreien Tagen.
 */
export function azubiMonthlyMinutes(
  cfg: AzubiConfig | undefined,
  year: number,
  month: number,
): number {
  const normalized = azubiConfigOf(cfg);
  const daysInMonth = new Date(year, month, 0).getDate();
  const hours = normalized.inSchoolTerm
    ? azubiTermHoursInMonth(normalized, year, month)
    : (azubiWeeklyHours(normalized) * daysInMonth) / 7;
  const rounded = Math.round(hours * 2) / 2; // halbe Stunden
  return Math.round(rounded * 60);
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
