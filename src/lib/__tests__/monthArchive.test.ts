import { describe, expect, it } from "vitest";
import type { Schedule, Shift } from "../../types";
import { listSavedMonths, monthKey, switchMonth } from "../monthArchive";
import { DEFAULT_WORK_HOURS } from "../workHours";

const shift = (id: string, date: string, paidMinutes = 6 * 60): Shift => ({
  id, employeeId: "e1", date, startMinutes: 11 * 60, endMinutes: 11 * 60 + paidMinutes,
  pauseMinutes: 0, paidMinutes, shiftType: "CUSTOM", generated: true,
});
const base = (year: number, month: number, shifts: Shift[]): Schedule => ({
  companyName: "T", address: "", holidayState: "BW", year, month,
  workHours: DEFAULT_WORK_HOURS, dateOverrides: [], employees: [], shifts,
});

describe("month archive", () => {
  it("keeps every generated month when switching back and forth", () => {
    const aug = [shift("a1", "2026-08-03"), shift("a2", "2026-08-04")];
    let st = { schedule: base(2026, 8, aug), originalShifts: aug };

    // August -> September: August wird abgelegt, September ist leer.
    st = switchMonth(st.schedule, st.originalShifts, 2026, 9, "t1");
    expect(st.schedule.shifts).toEqual([]);
    expect(st.schedule.archive?.[monthKey(2026, 8)]?.shifts).toEqual(aug);

    // September erzeugen, dann zurück zu August: August kommt unverändert zurück.
    const sep = [shift("s1", "2026-09-01")];
    st = { schedule: { ...st.schedule, shifts: sep }, originalShifts: sep };
    st = switchMonth(st.schedule, st.originalShifts, 2026, 8, "t2");
    expect(st.schedule.shifts).toEqual(aug);
    expect(st.originalShifts).toEqual(aug);
    expect(st.schedule.archive?.[monthKey(2026, 9)]?.shifts).toEqual(sep);
    expect(st.schedule.archive?.[monthKey(2026, 8)]).toBeUndefined(); // ist jetzt „offen"

    const months = listSavedMonths(st.schedule);
    expect(months.map((m) => [m.key, m.current, m.shiftCount])).toEqual([
      ["2026-08", true, 2],
      ["2026-09", false, 1],
    ]);
  });

  it("does not archive an empty month and keeps the year in the key", () => {
    const st = switchMonth(base(2026, 12, []), [], 2027, 1);
    expect(st.schedule.archive).toEqual({});
    expect(st.schedule.year).toBe(2027);
    expect(monthKey(2027, 1)).toBe("2027-01");
  });
});
