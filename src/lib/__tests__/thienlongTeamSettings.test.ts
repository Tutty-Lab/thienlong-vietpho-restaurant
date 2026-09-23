import { describe, expect, it } from "vitest";
import type { Employee, Shift } from "../../types";
import { generateSchedule } from "../scheduler";
import { teilzeitShiftCount } from "../splitTargetHours";
import { DEFAULT_WORK_HOURS, resolveDay } from "../workHours";
import { holidaysOf } from "../holidays";
import { isEmployeeFixedDayOff } from "../fixedDaysOff";
import { validateSchedule } from "../validation";

// Thienlong-Team wie im Live-Stand (Aug 2026): 4 Köche mit 6 Tagen/Woche,
// 4 Azubis mit 5 Tagen/Woche, 3 Aushilfen, 1 Vollzeit-Service ohne Tage/Woche.
const azubi = (hours: number) => ({ inSchoolTerm: false, schoolDays: [], monthlyHoursOutOfTerm: hours });
const team: Employee[] = [
  { id: "tl", name: "Service VZ", employmentType: "VOLLZEIT", targetMinutes: 192 * 60, workRole: "SERVICE", fixedDaysOff: ["sunday"] },
  { id: "hs", name: "Koch 1", employmentType: "VOLLZEIT", targetMinutes: 168 * 60, workRole: "KITCHEN", fixedDaysOff: ["tuesday"], desiredDaysPerWeek: 6 },
  { id: "hl", name: "Koch 2", employmentType: "VOLLZEIT", targetMinutes: 168 * 60, workRole: "KITCHEN", fixedDaysOff: ["wednesday"], desiredDaysPerWeek: 6 },
  { id: "qp", name: "Aushilfe 1", employmentType: "TEILZEIT", targetMinutes: 100 * 60, workRole: "SERVICE" },
  { id: "jl", name: "Koch 3", employmentType: "VOLLZEIT", targetMinutes: 168 * 60, workRole: "KITCHEN", fixedDaysOff: ["monday"], desiredDaysPerWeek: 6 },
  { id: "at", name: "Koch 4", employmentType: "VOLLZEIT", targetMinutes: 168 * 60, workRole: "KITCHEN", fixedDaysOff: ["thursday"], desiredDaysPerWeek: 6 },
  { id: "bm", name: "Aushilfe 2", employmentType: "TEILZEIT", targetMinutes: 20 * 60, workRole: "SERVICE" },
  { id: "pn", name: "Aushilfe 3", employmentType: "TEILZEIT", targetMinutes: 60 * 60, workRole: "SERVICE" },
  { id: "lh", name: "Azubi 1", employmentType: "AZUBI", targetMinutes: 174 * 60, workRole: "SERVICE", fixedDaysOff: ["monday", "wednesday"], desiredDaysPerWeek: 5, azubi: azubi(174) },
  { id: "pd", name: "Azubi 2", employmentType: "AZUBI", targetMinutes: 174 * 60, workRole: "KITCHEN", fixedDaysOff: ["sunday", "tuesday"], desiredDaysPerWeek: 5, azubi: azubi(174) },
  { id: "hh", name: "Azubi 3", employmentType: "AZUBI", targetMinutes: 174 * 60, workRole: "SERVICE", fixedDaysOff: ["tuesday", "thursday"], desiredDaysPerWeek: 5, azubi: azubi(174) },
  { id: "vd", name: "Azubi 4", employmentType: "AZUBI", targetMinutes: 174 * 60, workRole: "KITCHEN", fixedDaysOff: ["sunday", "friday"], desiredDaysPerWeek: 5, azubi: azubi(174) },
];

const year = 2026;
const month = 8;
const holidays = holidaysOf(year, "BW");
const shifts: Shift[] = generateSchedule({
  year,
  month,
  storeId: "thienlong",
  workHours: DEFAULT_WORK_HOURS,
  employees: team,
  holidayState: "BW",
});
const openDates = [...new Set(shifts.map((s) => s.date))].filter(
  (d) => !resolveDay(DEFAULT_WORK_HOURS, d, holidays, {}).closed,
);
const shiftsOf = (id: string) => shifts.filter((s) => s.employeeId === id);

describe("Thienlong with the real team settings", () => {
  it("hits every monthly target exactly and passes validation", () => {
    for (const e of team) {
      expect(shiftsOf(e.id).reduce((sum, s) => sum + s.paidMinutes, 0), e.name).toBe(e.targetMinutes);
    }
    expect(
      validateSchedule(team, shifts, { year, month, storeId: "thienlong", workHours: DEFAULT_WORK_HOURS, holidayState: "BW" }).errors,
    ).toEqual([]);
  });

  it("works exactly the requested days per week (every non-fixed-off day when that is all there is)", () => {
    for (const e of team.filter((x) => x.desiredDaysPerWeek)) {
      const eligible = openDates.filter((d) => !isEmployeeFixedDayOff(e, d));
      // 6 bzw. 5 Tage/Woche bei 1 bzw. 2 festen Ruhetagen = jeder erlaubte Tag.
      expect(shiftsOf(e.id).length, e.name).toBe(eligible.length);
    }
  });

  it("spreads full-time hours over the days (5–9 h, longer on thinly staffed days) instead of 9–10 h blocks", () => {
    for (const id of ["hs", "hl", "jl", "at"]) {
      for (const s of shiftsOf(id)) {
        expect(s.paidMinutes, `${id} ${s.date}`).toBeGreaterThanOrEqual(5 * 60);
        expect(s.paidMinutes, `${id} ${s.date}`).toBeLessThanOrEqual(9 * 60);
      }
    }
  });

  it("gives part-timers many short 2–4 h visits, one piece each, only at lunch or dinner", () => {
    for (const e of team.filter((x) => x.employmentType === "TEILZEIT")) {
      const mine = shiftsOf(e.id);
      // ≈ Soll / 2,5 h Einsätze (höchstens 6 von 7 Tagen).
      const planned = teilzeitShiftCount(e.targetMinutes / 60, Math.floor((openDates.length * 6) / 7));
      expect(mine.length, e.name).toBeGreaterThanOrEqual(planned - 1);
      expect(mine.length, e.name).toBeLessThanOrEqual(planned + 2);
      for (const s of mine) {
        expect(s.segments, `${e.name} ${s.date} ungeteilt`).toBeUndefined();
        expect(s.paidMinutes, `${e.name} ${s.date}`).toBeGreaterThanOrEqual(2 * 60);
        expect(s.paidMinutes, `${e.name} ${s.date}`).toBeLessThanOrEqual(4 * 60);
      }
      // Nur Mittag ODER Abend – Ausnahme nur, wenn sonst niemand öffnet/schließt.
      const offPeak = mine.filter((s) => {
        const lunch = s.startMinutes >= 10 * 60 + 30 && s.endMinutes <= 15 * 60;
        const dinner = s.startMinutes >= 16 * 60 + 30 && s.endMinutes <= 22 * 60;
        return !lunch && !dinner;
      });
      expect(offPeak.length, e.name).toBeLessThanOrEqual(Math.ceil(mine.length * 0.1));
    }
  });

  it("keeps at least two kitchen and two service people on every open day", () => {
    const roleOf = new Map(team.map((e) => [e.id, e.workRole]));
    for (const date of openDates) {
      for (const role of ["KITCHEN", "SERVICE"] as const) {
        const people = shifts.filter((s) => s.date === date && roleOf.get(s.employeeId) === role).length;
        expect(people, `${role} ${date}`).toBeGreaterThanOrEqual(2);
      }
    }
  });

  it("never leaves a 30-minute slot without kitchen or without service", () => {
    const roleOf = new Map(team.map((e) => [e.id, e.workRole]));
    for (const date of openDates) {
      const day = resolveDay(DEFAULT_WORK_HOURS, date, holidays, {});
      for (const block of day.blocks) {
        for (let t = block.startMinutes; t + 30 <= block.endMinutes; t += 30) {
          for (const role of ["KITCHEN", "SERVICE"] as const) {
            const present = shifts.some(
              (s) =>
                s.date === date &&
                roleOf.get(s.employeeId) === role &&
                (s.segments ?? [s]).some((g) => g.startMinutes <= t && g.endMinutes >= t + 30),
            );
            expect(present, `${role} ${date} ${t / 60}h`).toBe(true);
          }
        }
      }
    }
  });
});

describe("standard shifts anchored on the peaks", () => {
  it("keeps almost every shift piece standard (≥ 3 h covers 11–14 or 17–20, shorter lies inside)", () => {
    const holidaysSet = holidaysOf(2026, "BW");
    let standard = 0;
    let all = 0;
    for (const s of shifts) {
      const day = resolveDay(DEFAULT_WORK_HOURS, s.date, holidaysSet, {});
      const open = day.blocks[0].startMinutes;
      const peaks = [[Math.max(11 * 60, open), 14 * 60], [17 * 60, 20 * 60]];
      for (const g of s.segments ?? [s]) {
        all += 1;
        const len = g.endMinutes - g.startMinutes;
        const ok = len >= 180
          ? peaks.some(([a, b]) => g.startMinutes <= a && g.endMinutes >= b)
          : peaks.some(([a, b]) => g.startMinutes >= a && g.endMinutes <= b);
        if (ok) standard += 1;
      }
    }
    expect(standard / all).toBeGreaterThanOrEqual(0.95);
  });

  it("gives the same plan for the same input (deterministic)", () => {
    const again = generateSchedule({
      year,
      month,
      storeId: "thienlong",
      workHours: DEFAULT_WORK_HOURS,
      employees: team,
      holidayState: "BW",
    });
    expect(again).toEqual(shifts);
  });
});
