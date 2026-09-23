import { describe, expect, it } from "vitest";
import type { Schedule, Shift } from "../../types";
import { listSavedMonths, mergeArchives, monthKey, switchMonth } from "../monthArchive";
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

describe("merging archives from another tab/device", () => {
  it("keeps months the other copy has saved, never drops own months", () => {
    const aug = [shift("a", "2026-08-03")];
    const sep = [shift("s", "2026-09-01")];
    // Dieser Tab: August offen, September gespeichert.
    const mine = { ...base(2026, 8, aug), archive: { "2026-09": { shifts: sep, originalShifts: sep, savedAt: "x" } } };
    // Veralteter Tab: nur Juli gespeichert, August offen (alte Version).
    const jul = [shift("j", "2026-07-01")];
    const stale = { ...base(2026, 8, [shift("old", "2026-08-05")]), archive: { "2026-07": { shifts: jul, originalShifts: jul, savedAt: "y" } } };

    const merged = mergeArchives(mine, stale);
    expect(Object.keys(merged.archive ?? {}).sort()).toEqual(["2026-07", "2026-09"]);
    expect(merged.shifts).toEqual(aug); // eigener offener Monat bleibt
    expect(mergeArchives(merged, stale)).toBe(merged); // nichts Neues -> gleiche Referenz
  });

  it("stores the other copy's open month if this copy does not have it", () => {
    const sep = [shift("s", "2026-09-01")];
    const mine = base(2026, 8, [shift("a", "2026-08-03")]);
    const other = base(2026, 9, sep);
    expect(mergeArchives(mine, other).archive?.["2026-09"]?.shifts).toEqual(sep);
  });
});
