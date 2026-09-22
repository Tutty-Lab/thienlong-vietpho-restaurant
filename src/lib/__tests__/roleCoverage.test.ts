import { describe, expect, it } from "vitest";
import type { Employee, Shift } from "../../types";
import { generateSchedule } from "../scheduler";
import { DEFAULT_WORK_HOURS } from "../workHours";
import { resolveDay } from "../workHours";
import { holidaysOf } from "../holidays";

const segmentsOf = (shift: Shift) =>
  shift.segments ?? [{ startMinutes: shift.startMinutes, endMinutes: shift.endMinutes }];

// Genügend Personal je Rolle, damit an offenen Tagen jede Rolle ≥2 Schichten hat.
const employees: Employee[] = [
  { id: "k1", name: "Koch 1", employmentType: "VOLLZEIT", targetMinutes: 176 * 60, workRole: "KITCHEN" },
  { id: "k2", name: "Koch 2", employmentType: "VOLLZEIT", targetMinutes: 176 * 60, workRole: "KITCHEN" },
  { id: "k3", name: "Koch 3", employmentType: "VOLLZEIT", targetMinutes: 168 * 60, workRole: "KITCHEN" },
  { id: "k4", name: "Koch 4", employmentType: "TEILZEIT", targetMinutes: 120 * 60, workRole: "KITCHEN" },
  { id: "s1", name: "Service 1", employmentType: "VOLLZEIT", targetMinutes: 176 * 60, workRole: "SERVICE" },
  { id: "s2", name: "Service 2", employmentType: "VOLLZEIT", targetMinutes: 176 * 60, workRole: "SERVICE" },
  { id: "s3", name: "Service 3", employmentType: "VOLLZEIT", targetMinutes: 168 * 60, workRole: "SERVICE" },
  { id: "s4", name: "Service 4", employmentType: "TEILZEIT", targetMinutes: 120 * 60, workRole: "SERVICE" },
];

describe("role coverage at opening and closing", () => {
  it("keeps at least one kitchen and one service at open and close on every open day (when the role has ≥2 shifts), without changing monthly totals", () => {
    const year = 2026;
    const month = 8;
    const shifts = generateSchedule({
      year,
      month,
      storeId: "thienlong",
      workHours: DEFAULT_WORK_HOURS,
      employees,
      holidayState: "BW",
    });

    const roleOf = new Map(employees.map((e) => [e.id, e.workRole]));
    const holidays = holidaysOf(year, "BW");
    const dates = [...new Set(shifts.map((s) => s.date))];

    for (const date of dates) {
      const day = resolveDay(DEFAULT_WORK_HOURS, date, holidays, {});
      if (day.closed) continue;
      const openMinutes = day.blocks[0].startMinutes;
      const closeMinutes = day.blocks[day.blocks.length - 1].endMinutes;

      for (const role of ["KITCHEN", "SERVICE"] as const) {
        const roleShifts = shifts.filter((s) => s.date === date && roleOf.get(s.employeeId) === role);
        if (roleShifts.length < 2) continue; // Mit einer Schicht ist beides unmöglich.

        const opens = roleShifts.some((s) =>
          segmentsOf(s).some((seg) => seg.startMinutes <= openMinutes),
        );
        const closes = roleShifts.some((s) =>
          segmentsOf(s).some((seg) => seg.endMinutes >= closeMinutes),
        );
        expect(opens, `${role} deckt Öffnung ${date}`).toBe(true);
        expect(closes, `${role} deckt Schluss ${date}`).toBe(true);
      }
    }

    // Monatssoll bleibt exakt (Coverage-Reparatur verschiebt nur Zeiten).
    for (const e of employees) {
      const worked = shifts
        .filter((s) => s.employeeId === e.id)
        .reduce((sum, s) => sum + s.paidMinutes, 0);
      expect(worked, `${e.name} Soll`).toBe(e.targetMinutes);
    }
  });
});
