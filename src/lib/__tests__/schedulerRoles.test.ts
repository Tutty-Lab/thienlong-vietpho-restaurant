import { describe, expect, it } from "vitest";
import type { Employee, WorkRole } from "../../types";
import { datesOfMonth, parseIsoDate, weekdayKeyOf } from "../demand";
import { generateSchedule } from "../scheduler";
import { demandCoverageGap, thienlongDemandIntervals } from "../thienlongDemand";
import { DEFAULT_WORK_HOURS } from "../workHours";

const employees: Employee[] = Array.from({ length: 8 }, (_, index) => ({
  id: `role-${index}`,
  name: `Role ${index}`,
  employmentType: "AZUBI",
  targetMinutes: 120 * 60,
  workRole: (index < 5 ? "KITCHEN" : "SERVICE") as WorkRole,
}));

function monthlyRoleGap(shifts: ReturnType<typeof generateSchedule>): number {
  const byId = new Map(employees.map((employee) => [employee.id, employee] as const));

  return datesOfMonth(2026, 8).reduce((monthGap, date) => {
    const weekday = weekdayKeyOf(parseIsoDate(date));
    return monthGap + (["KITCHEN", "SERVICE"] as const).reduce((dayGap, role) => {
      const roleShifts = shifts.filter(
        (shift) => shift.date === date && byId.get(shift.employeeId)?.workRole === role,
      );
      return dayGap + demandCoverageGap(roleShifts, thienlongDemandIntervals(weekday, role));
    }, 0);
  }, 0);
}

describe("Thienlong role-aware scheduling", () => {
  it("reduces uncovered Kitchen and Service intervals compared with the generic scheduler", () => {
    const common = {
      year: 2026,
      month: 8,
      workHours: DEFAULT_WORK_HOURS,
      holidays: new Set<string>(),
      employees,
      seed: "role-coverage",
    };

    const generic = generateSchedule(common);
    const thienlong = generateSchedule({ ...common, storeId: "thienlong" });

    expect(monthlyRoleGap(thienlong)).toBeLessThan(monthlyRoleGap(generic));
  });
});
