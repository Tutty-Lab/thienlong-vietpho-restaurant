import { describe, expect, it } from "vitest";
import type { Employee } from "../../types";
import { parseIsoDate } from "../demand";
import { generateSchedule } from "../scheduler";
import { DEFAULT_WORK_HOURS } from "../workHours";

/** Montags-Wochenschlüssel (wie im Scheduler). */
function weekKey(iso: string): string {
  const d = parseIsoDate(iso);
  const back = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - back);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

/**
 * Arbeitstage je VOLLER Woche eines Mitarbeiters (Rand­wochen, die nur teilweise
 * im Monat liegen, werden ausgeklammert – dort sind zwangsläufig weniger Tage).
 */
function fullWeekDayCounts(
  shifts: { employeeId: string; date: string }[],
  employeeId: string,
  monthDates: string[],
): number[] {
  const daysInMonthByWeek = new Map<string, number>();
  for (const iso of monthDates) {
    const k = weekKey(iso);
    daysInMonthByWeek.set(k, (daysInMonthByWeek.get(k) ?? 0) + 1);
  }
  const worked = new Map<string, number>();
  for (const s of shifts) {
    if (s.employeeId !== employeeId) continue;
    const k = weekKey(s.date);
    worked.set(k, (worked.get(k) ?? 0) + 1);
  }
  const counts: number[] = [];
  for (const [k, count] of worked) {
    if ((daysInMonthByWeek.get(k) ?? 0) >= 7) counts.push(count);
  }
  return counts;
}

function datesOf(year: number, month: number): string[] {
  const out: string[] = [];
  const days = new Date(year, month, 0).getDate();
  for (let d = 1; d <= days; d++) {
    out.push(`${year}-${String(month).padStart(2, "0")}-${String(d).padStart(2, "0")}`);
  }
  return out;
}

describe("desiredDaysPerWeek", () => {
  const base: Employee[] = [
    { id: "vz-a", name: "VZ A", employmentType: "VOLLZEIT", targetMinutes: 176 * 60, workRole: "KITCHEN" },
    { id: "vz-b", name: "VZ B", employmentType: "VOLLZEIT", targetMinutes: 176 * 60, workRole: "KITCHEN" },
    { id: "vz-c", name: "VZ C", employmentType: "VOLLZEIT", targetMinutes: 176 * 60, workRole: "SERVICE" },
    { id: "tz-a", name: "TZ A", employmentType: "TEILZEIT", targetMinutes: 80 * 60, workRole: "SERVICE" },
    { id: "tz-b", name: "TZ B", employmentType: "TEILZEIT", targetMinutes: 80 * 60, workRole: "SERVICE" },
    { id: "vz-d", name: "VZ D", employmentType: "VOLLZEIT", targetMinutes: 176 * 60, workRole: "KITCHEN" },
  ];

  it("keeps a set employee within ±1 of the desired days per full week and meets the target", () => {
    const employees = base.map((e) =>
      e.id === "vz-a" ? { ...e, desiredDaysPerWeek: 4 } : e,
    );
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

    const counts = fullWeekDayCounts(shifts, "vz-a", datesOf(year, month));
    expect(counts.length).toBeGreaterThan(0);
    for (const c of counts) {
      expect(c).toBeGreaterThanOrEqual(3); // N-1
      expect(c).toBeLessThanOrEqual(5); // N+1
    }

    // Monats-Soll wird exakt erreicht.
    const worked = shifts
      .filter((s) => s.employeeId === "vz-a")
      .reduce((sum, s) => sum + s.paidMinutes, 0);
    expect(worked).toBe(176 * 60);
  });

  it("does not change employees without the setting (still meets their target)", () => {
    const year = 2026;
    const month = 8;
    const shifts = generateSchedule({
      year,
      month,
      storeId: "thienlong",
      workHours: DEFAULT_WORK_HOURS,
      employees: base,
      holidayState: "BW",
    });
    for (const e of base) {
      const worked = shifts
        .filter((s) => s.employeeId === e.id)
        .reduce((sum, s) => sum + s.paidMinutes, 0);
      expect(worked).toBe(e.targetMinutes);
    }
  });
});
