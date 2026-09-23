import { describe, expect, it } from "vitest";
import type { Employee, Shift } from "../../types";
import { generateSchedule } from "../scheduler";
import { validateSchedule } from "../validation";
import { DEFAULT_WORK_HOURS, resolveDay } from "../workHours";
import { holidaysOf } from "../holidays";
import { parseIsoDate, weekdayKeyOf } from "../demand";

// Monat, in dem alle Azubis in der Berufsschule sind: 4 Köche, 1 Vollzeit-Bồi
// (6 Tage/Woche, So frei) und 3 Aushilfen mit kurzen Einsätzen.
const team: Employee[] = [
  { id: "tl", name: "Bồi VZ", employmentType: "VOLLZEIT", targetMinutes: 192 * 60, workRole: "SERVICE", fixedDaysOff: ["sunday"], desiredDaysPerWeek: 6 },
  { id: "hs", name: "Koch 1", employmentType: "VOLLZEIT", targetMinutes: 168 * 60, workRole: "KITCHEN", fixedDaysOff: ["tuesday"], desiredDaysPerWeek: 6 },
  { id: "hl", name: "Koch 2", employmentType: "VOLLZEIT", targetMinutes: 168 * 60, workRole: "KITCHEN", fixedDaysOff: ["wednesday"], desiredDaysPerWeek: 6 },
  { id: "jl", name: "Koch 3", employmentType: "VOLLZEIT", targetMinutes: 168 * 60, workRole: "KITCHEN", fixedDaysOff: ["monday"], desiredDaysPerWeek: 6 },
  { id: "at", name: "Koch 4", employmentType: "VOLLZEIT", targetMinutes: 168 * 60, workRole: "KITCHEN", fixedDaysOff: ["thursday"], desiredDaysPerWeek: 6 },
  { id: "qp", name: "Aushilfe 1", employmentType: "TEILZEIT", targetMinutes: 100 * 60, workRole: "SERVICE" },
  { id: "bm", name: "Aushilfe 2", employmentType: "TEILZEIT", targetMinutes: 20 * 60, workRole: "SERVICE" },
  { id: "pn", name: "Aushilfe 3", employmentType: "TEILZEIT", targetMinutes: 60 * 60, workRole: "SERVICE" },
];
const context = { year: 2026, month: 8, storeId: "thienlong", workHours: DEFAULT_WORK_HOURS, holidayState: "BW" as const };

describe("no slot without kitchen or service", () => {
  const shifts = generateSchedule({ ...context, employees: team });
  const holidays = holidaysOf(2026, "BW");
  const roleOf = new Map(team.map((e) => [e.id, e.workRole]));

  it("keeps monthly targets exact while closing gaps", () => {
    for (const e of team) {
      expect(shifts.filter((s) => s.employeeId === e.id).reduce((a, s) => a + s.paidMinutes, 0), e.name).toBe(
        e.targetMinutes,
      );
    }
  });

  it("covers every slot with service on every day the full-time Bồi works", () => {
    const dates = [...new Set(shifts.map((s) => s.date))];
    for (const date of dates) {
      if (weekdayKeyOf(parseIsoDate(date)) === "sunday") continue; // Bồi VZ fest frei
      const day = resolveDay(DEFAULT_WORK_HOURS, date, holidays, {});
      for (const block of day.blocks) {
        for (let t = block.startMinutes; t + 30 <= block.endMinutes; t += 30) {
          const covered = shifts.some(
            (s) =>
              s.date === date &&
              roleOf.get(s.employeeId) === "SERVICE" &&
              (s.segments ?? [s]).some((g) => g.startMinutes <= t && g.endMinutes >= t + 30),
          );
          expect(covered, `Bồi ${date} ${t / 60}h`).toBe(true);
        }
      }
    }
  });

  it("reports a slot without service as a validation error", () => {
    const shift: Shift = {
      id: "x", employeeId: "tl", date: "2026-08-03", startMinutes: 10 * 60 + 30, endMinutes: 15 * 60,
      pauseMinutes: 0, segments: [{ startMinutes: 10 * 60 + 30, endMinutes: 15 * 60 }, { startMinutes: 16 * 60 + 30, endMinutes: 20 * 60 }],
      paidMinutes: 8 * 60, shiftType: "CUSTOM", generated: false,
    };
    shift.endMinutes = 20 * 60;
    const errors = validateSchedule(team, [shift], context).errors.map((e) => e.message);
    expect(errors).toContain("Ngày 2026-08-03: không có Bồi lúc 20:00–22:00.");
  });
});
