// ============================================================================
// Bếp/Bồi-Besetzung eines Tages – EINE Rechnung für Planer, Prüfung und UI.
//
// Die Rolle einer Person gilt für den ganzen Monat: Hauptrolle oder – bei
// „Làm được cả Bếp và Bồi" – die für diesen Monat gewählte (roleByMonth).
// ============================================================================

import type { Employee, Shift, WorkRole } from "../types";
import type { WeekdayKey } from "./demand";
import { worksDinner, worksLunch } from "./shiftMeals";
import { thienlongMinStaffWindows } from "./thienlongDemand";

export const ROLES: readonly WorkRole[] = ["KITCHEN", "SERVICE"];
export const roleLabel = (role: WorkRole) => (role === "KITCHEN" ? "Bếp" : "Bồi");

const monthKeyOf = (year: number, month: number) => `${year}-${String(month).padStart(2, "0")}`;

/** Rolle der Person in diesem Monat. */
export function monthRole(employee: Employee, year: number, month: number): WorkRole | undefined {
  if (employee.canSwitchRole) {
    const override = employee.roleByMonth?.[monthKeyOf(year, month)];
    if (override) return override;
  }
  return employee.workRole;
}

/** Mitarbeiter mit der Rolle dieses Monats als workRole (für Planer, Prüfung, Anzeige). */
export function withMonthRoles(employees: readonly Employee[], year: number, month: number): Employee[] {
  return employees.map((e) => {
    const role = monthRole(e, year, month);
    return role === e.workRole ? e : { ...e, workRole: role };
  });
}

/** Hat die Person diesen Monat eine andere Rolle als ihre Hauptrolle? */
export function isRoleSwitchedInMonth(employee: Employee, year: number, month: number): boolean {
  return monthRole(employee, year, month) !== employee.workRole;
}

export type RoleOf = (shift: Shift) => WorkRole | undefined;

type Block = { startMinutes: number; endMinutes: number };

export type DayRoleIssues = {
  /** 30-min-Slots ohne jemanden dieser Rolle. */
  gaps: { role: WorkRole; slots: number[] }[];
  /** Fr/Sa/So-Mindestbesetzung unterschritten. */
  minStaff: { role: WorkRole; startMinutes: number; endMinutes: number; minStaff: number; short: number[] }[];
  /** Abends weniger Leute dieser Rolle als mittags. */
  eveningBelowLunch: { role: WorkRole; lunch: number; dinner: number }[];
};

const covers = (shift: Shift, t: number) =>
  (shift.segments ?? [shift]).some((g) => g.startMinutes <= t && g.endMinutes >= t + 30);

/** Wie viele dieser Rolle arbeiten um t (30-min-Slot)? */
export function roleCountAt(dayShifts: readonly Shift[], roleOf: RoleOf, role: WorkRole, t: number): number {
  return dayShifts.filter((s) => roleOf(s) === role && covers(s, t)).length;
}

/**
 * Alle Rollen-Regeln eines Tages. `rolesInTeam` = Rollen, die es im Team
 * überhaupt gibt (sonst wäre z. B. ein Laden ohne Bồi immer „fehlerhaft").
 */
export function dayRoleIssues(
  dayShifts: readonly Shift[],
  roleOf: RoleOf,
  blocks: readonly Block[],
  weekday: WeekdayKey,
  rolesInTeam: readonly WorkRole[] = ROLES,
): DayRoleIssues {
  const issues: DayRoleIssues = { gaps: [], minStaff: [], eveningBelowLunch: [] };
  for (const role of rolesInTeam) {
    const mine = dayShifts.filter((s) => roleOf(s) === role);
    const gapSlots: number[] = [];
    for (const b of blocks) {
      for (let t = b.startMinutes; t + 30 <= b.endMinutes; t += 30) {
        if (!mine.some((s) => covers(s, t))) gapSlots.push(t);
      }
    }
    if (gapSlots.length > 0) issues.gaps.push({ role, slots: gapSlots });

    for (const w of thienlongMinStaffWindows(weekday, role)) {
      const short: number[] = [];
      for (let t = w.startMinutes; t + 30 <= w.endMinutes; t += 30) {
        if (!blocks.some((b) => b.startMinutes <= t && b.endMinutes >= t + 30)) continue;
        if (mine.filter((s) => covers(s, t)).length < w.minStaff) short.push(t);
      }
      if (short.length > 0) issues.minStaff.push({ role, ...w, short });
    }

    const lunch = mine.filter(worksLunch).length;
    const dinner = mine.filter(worksDinner).length;
    if (dinner < lunch) issues.eveningBelowLunch.push({ role, lunch, dinner });
  }
  return issues;
}

/** Gewichtete Summe (gleiche Rangfolge wie im Planer: Lücke > Mindestbesetzung > Abend). */
export function dayRoleCost(issues: DayRoleIssues): number {
  return (
    issues.gaps.reduce((a, g) => a + g.slots.length * 1000, 0) +
    issues.minStaff.reduce((a, m) => a + m.short.length * 800, 0) +
    issues.eveningBelowLunch.reduce((a, e) => a + (e.lunch - e.dinner) * 400, 0)
  );
}
