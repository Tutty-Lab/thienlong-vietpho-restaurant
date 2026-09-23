import { describe, expect, it } from "vitest";
import type { Employee } from "../../types";
import { azubiMonthlyHoursForMonth } from "../azubi";
import { azubiMonthCapacityMinutes, generateSchedule } from "../scheduler";
import { DEFAULT_WORK_HOURS } from "../workHours";

const azubi = (extra: Partial<NonNullable<Employee["azubi"]>> = {}): Employee => ({
  id: "lh",
  name: "La Thi Hang",
  employmentType: "AZUBI",
  targetMinutes: 174 * 60,
  workRole: "SERVICE",
  fixedDaysOff: ["monday", "wednesday"],
  desiredDaysPerWeek: 5,
  azubi: { inSchoolTerm: false, schoolDays: [], monthlyHoursOutOfTerm: 174, ...extra },
});

describe("Azubi hours for a single work month", () => {
  it("September 2026 only fits 170 h with Mon+Wed off (4 full weeks × 40 h + one Tuesday)", () => {
    const max = azubiMonthCapacityMinutes(azubi(), {
      year: 2026, month: 9, workHours: DEFAULT_WORK_HOURS, holidayState: "BW",
    });
    expect(max / 60).toBe(170);
    // August fits 174 h.
    const aug = azubiMonthCapacityMinutes(azubi(), {
      year: 2026, month: 8, workHours: DEFAULT_WORK_HOURS, holidayState: "BW",
    });
    expect(aug / 60).toBeGreaterThanOrEqual(174);
  });

  it("a per-month work override applies only to that month", () => {
    const cfg = azubi({ workMonthHoursByMonth: { "2026-09": 168 } }).azubi;
    expect(azubiMonthlyHoursForMonth(cfg, 2026, 9)).toBe(168);
    expect(azubiMonthlyHoursForMonth(cfg, 2026, 10)).toBe(174);
    expect(azubiMonthlyHoursForMonth(cfg, 2026, 8)).toBe(174);
  });

  it("a school-month value never leaks into a work month", () => {
    const cfg = azubi({ monthlyHoursByMonth: { "2026-09": 40 } }).azubi;
    expect(azubiMonthlyHoursForMonth(cfg, 2026, 9)).toBe(174);
  });

  it("with 170 h set for September the month can be generated", () => {
    const e = { ...azubi({ workMonthHoursByMonth: { "2026-09": 170 } }), targetMinutes: 170 * 60 };
    const shifts = generateSchedule({
      year: 2026, month: 9, storeId: "thienlong", workHours: DEFAULT_WORK_HOURS, holidayState: "BW",
      employees: [e],
    });
    expect(shifts.reduce((a, s) => a + s.paidMinutes, 0)).toBe(170 * 60);
  });
});
