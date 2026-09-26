// ============================================================================
// „Tìm cách xếp khác": probiert Rollenwechsel für den GANZEN Monat durch
// (z. B. Koch macht den Monat Service, weil die Azubi-Bồi in der Schule sind),
// erzeugt für jede Variante einen Probe-Plan und zählt die verbleibenden
// Fehler. Vorgeschlagen wird nur, was tatsächlich weniger Fehler ergibt.
// ============================================================================

import type { Employee, WorkRole } from "../types";
import { generateSchedule, type GenerateInput } from "./scheduler";
import { validateSchedule } from "./validation";
import { monthRole, roleLabel, withMonthRoles } from "./roleCoverage";

export type RoleChange = { employeeId: string; name: string; from: WorkRole; to: WorkRole };

export type RoleSwitchOption = {
  changes: RoleChange[];
  errors: number;
  coverageErrors: number;
  /** Person war noch nicht als „Làm được cả Bếp và Bồi" markiert. */
  needsFlag: boolean;
};

export type RoleSwitchResult = {
  baselineErrors: number;
  baselineCoverage: number;
  options: RoleSwitchOption[];
  /** Wurden auch nicht markierte Leute probiert (weil niemand markiert ist)? */
  triedUnflagged: boolean;
};

type Context = Omit<GenerateInput, "employees"> & { year: number; month: number };

const monthKey = (year: number, month: number) => `${year}-${String(month).padStart(2, "0")}`;
const other = (r: WorkRole): WorkRole => (r === "KITCHEN" ? "SERVICE" : "KITCHEN");

/** Mitarbeiter mit den Monats-Rollen-Änderungen (setzt canSwitchRole mit). */
export function applyRoleChanges(
  employees: readonly Employee[],
  changes: readonly RoleChange[],
  year: number,
  month: number,
): Employee[] {
  const key = monthKey(year, month);
  return employees.map((e) => {
    const change = changes.find((c) => c.employeeId === e.id);
    if (!change) return e;
    const roleByMonth = { ...(e.roleByMonth ?? {}) };
    if (change.to === e.workRole) delete roleByMonth[key];
    else roleByMonth[key] = change.to;
    return {
      ...e,
      canSwitchRole: true,
      roleByMonth: Object.keys(roleByMonth).length > 0 ? roleByMonth : undefined,
    };
  });
}

function evaluate(
  employees: Employee[],
  ctx: Context,
): { errors: number; coverage: number; shortRoles: WorkRole[] } | null {
  const planned = withMonthRoles(employees, ctx.year, ctx.month);
  try {
    const shifts = generateSchedule({ ...ctx, employees: planned, quick: true });
    const errors = validateSchedule(planned, shifts, {
      year: ctx.year,
      month: ctx.month,
      workHours: ctx.workHours,
      holidayState: ctx.holidayState ?? "BW",
      storeId: ctx.storeId,
      overrides: ctx.overrides,
    }).errors;
    const coverage = errors.filter((e) => e.kind === "coverage");
    const shortRoles = (["KITCHEN", "SERVICE"] as const).filter((r) =>
      coverage.some((e) => e.message.includes(` ${roleLabel(r)} `) || e.message.includes(`${roleLabel(r)} tối`)),
    );
    return { errors: errors.length, coverage: coverage.length, shortRoles };
  } catch {
    return null; // Variante nicht planbar (z. B. Monatssoll nicht erreichbar)
  }
}

const nextTick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/**
 * Probiert Rollenwechsel für den Monat. `employees` = Monats-Solls bereits
 * berechnet. `onProgress` für die Anzeige („Đang thử 3/7…").
 */
export async function findRoleSwitchOptions(
  employees: readonly Employee[],
  ctx: Context,
  onProgress?: (done: number, total: number) => void,
): Promise<RoleSwitchResult> {
  const baseline = evaluate([...employees], ctx);
  // Nur in die Rolle wechseln, die tatsächlich fehlt (aus den Fehlern des Probe-Plans).
  const shortRoles = new Set<WorkRole>(baseline?.shortRoles ?? ["KITCHEN", "SERVICE"]);
  const flagged = employees.filter(
    (e) => e.canSwitchRole && e.workRole && e.targetMinutes > 0 && shortRoles.has(other(monthRole(e, ctx.year, ctx.month)!)),
  );
  // Niemand markiert: alle Nicht-Azubis probieren – der Chef entscheidet.
  const triedUnflagged = flagged.length === 0;
  const candidates = (triedUnflagged
    ? employees.filter(
        (e) =>
          e.workRole &&
          e.targetMinutes > 0 &&
          e.employmentType !== "AZUBI" &&
          shortRoles.has(other(monthRole(e, ctx.year, ctx.month)!)),
      )
    : flagged
  ).map((e): RoleChange => {
    const current = monthRole(e, ctx.year, ctx.month)!;
    return { employeeId: e.id, name: e.name, from: current, to: other(current) };
  });

  const total = candidates.length + Math.min(3, candidates.length * (candidates.length - 1) / 2) + 1;
  let done = 0;
  const step = async () => {
    done += 1;
    onProgress?.(done, total);
    await nextTick();
  };

  await step();
  const baselineErrors = baseline?.errors ?? Number.POSITIVE_INFINITY;
  const baselineCoverage = baseline?.coverage ?? Number.POSITIVE_INFINITY;

  const singles: RoleSwitchOption[] = [];
  for (const change of candidates) {
    const result = evaluate(applyRoleChanges(employees, [change], ctx.year, ctx.month), ctx);
    await step();
    if (!result) continue;
    const e = employees.find((x) => x.id === change.employeeId)!;
    singles.push({ changes: [change], errors: result.errors, coverageErrors: result.coverage, needsFlag: !e.canSwitchRole });
  }

  // Paare aus den drei besten Einzel-Wechseln (z. B. zwei Köche → Service).
  const best = [...singles].sort((a, b) => a.errors - b.errors).slice(0, 3);
  const pairs: RoleSwitchOption[] = [];
  for (let i = 0; i < best.length; i++) {
    for (let j = i + 1; j < best.length; j++) {
      const changes = [...best[i].changes, ...best[j].changes];
      const result = evaluate(applyRoleChanges(employees, changes, ctx.year, ctx.month), ctx);
      await step();
      if (!result) continue;
      pairs.push({
        changes,
        errors: result.errors,
        coverageErrors: result.coverage,
        needsFlag: best[i].needsFlag || best[j].needsFlag,
      });
    }
  }

  const options = [...singles, ...pairs]
    .filter((o) => o.errors < baselineErrors)
    .sort((a, b) => a.errors - b.errors || a.changes.length - b.changes.length)
    .slice(0, 4);
  return { baselineErrors, baselineCoverage, options, triedUnflagged };
}

/** „Hong Son: Bếp → Bồi" */
export function describeChanges(changes: readonly RoleChange[]): string {
  return changes.map((c) => `${c.name}: ${roleLabel(c.from)} → ${roleLabel(c.to)}`).join(", ");
}
