import { describe, expect, it } from "vitest";
import { generateSchedule } from "../scheduler";
import { validateSchedule } from "../validation";
import { maxConsecutiveRun } from "../consecutive";
import { SAMPLE_EMPLOYEES } from "../sampleData";
import { DEFAULT_WORK_HOURS, resolveDay } from "../workHours";
import { holidaysOf } from "../holidays";
import { calculatePause } from "../time";
import { DAY_WEIGHTS, LATE_SHIFT_RATIOS, datesOfMonth } from "../demand";

describe("Scheduler – August 2026 Beispieldaten", () => {
  const shifts = generateSchedule({
    year: 2026,
    month: 8,
    workHours: DEFAULT_WORK_HOURS,
    employees: SAMPLE_EMPLOYEES,
  });

  it("verteilt insgesamt genau 793 bezahlte Stunden", () => {
    const totalMinutes = shifts.reduce((s, x) => s + x.paidMinutes, 0);
    expect(totalMinutes).toBe(793 * 60);
  });

  it("trifft jedes einzelne Mitarbeiter-Soll exakt", () => {
    const expected: Record<string, number> = {
      VZ1: 120, VZ2: 124, VZ3: 118, VZ4: 122,
      TZ1: 40, TZ2: 55, TZ3: 55, TZ4: 79, TZ5: 80,
    };
    for (const emp of SAMPLE_EMPLOYEES) {
      const assigned = shifts
        .filter((s) => s.employeeId === emp.id)
        .reduce((sum, s) => sum + s.paidMinutes, 0);
      expect(assigned).toBe(expected[emp.id] * 60);
    }
  });

  it("hält alle harten Regeln ein (Validierung grün)", () => {
    const result = validateSchedule(SAMPLE_EMPLOYEES, shifts, {
      year: 2026,
      month: 8,
      workHours: DEFAULT_WORK_HOURS,
      holidayState: "BW",
    });
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it("höchstens ein Dienst pro Mitarbeiter und Tag", () => {
    const seen = new Set<string>();
    for (const s of shifts) {
      const key = `${s.employeeId}#${s.date}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
  });

  it("nie mehr als 6 aufeinanderfolgende Arbeitstage", () => {
    for (const emp of SAMPLE_EMPLOYEES) {
      const dates = shifts.filter((s) => s.employeeId === emp.id).map((s) => s.date);
      expect(maxConsecutiveRun(dates)).toBeLessThanOrEqual(6);
    }
  });

  it("gibt jedem Mitarbeiter mindestens vier freie Tage im Monat", () => {
    const daysInMonth = datesOfMonth(2026, 8).length;
    for (const emp of SAMPLE_EMPLOYEES) {
      const workedDays = new Set(
        shifts.filter((shift) => shift.employeeId === emp.id).map((shift) => shift.date),
      ).size;
      expect(daysInMonth - workedDays, emp.name).toBeGreaterThanOrEqual(4);
    }
  });

  it("jede Schicht: paid <= 10 h und korrekte Pause", () => {
    for (const s of shifts) {
      expect(s.paidMinutes).toBeLessThanOrEqual(10 * 60);
      // Geteilter Dienst: keine gerechnete Pause, bezahlte Zeit = Summe der Stücke.
      const split = Boolean(s.segments && s.segments.length > 1);
      expect(s.pauseMinutes).toBe(split ? 0 : calculatePause(s.paidMinutes));
      const paid = split
        ? s.segments!.reduce((x, g) => x + (g.endMinutes - g.startMinutes), 0)
        : s.endMinutes - s.startMinutes - s.pauseMinutes;
      expect(paid).toBe(s.paidMinutes);
    }
  });

  it("ist deterministisch (gleiche Eingabe => gleiche Ausgabe)", () => {
    const again = generateSchedule({
      year: 2026,
      month: 8,
      workHours: DEFAULT_WORK_HOURS,
      employees: SAMPLE_EMPLOYEES,
    });
    expect(again.map((s) => `${s.date}|${s.employeeId}|${s.paidMinutes}|${s.shiftType}`)).toEqual(
      shifts.map((s) => `${s.date}|${s.employeeId}|${s.paidMinutes}|${s.shiftType}`),
    );
  });

  it("plant mehr Stunden am Samstag als am Montag", () => {
    const byDate = new Map<string, number>();
    for (const s of shifts) {
      byDate.set(s.date, (byDate.get(s.date) ?? 0) + s.paidMinutes);
    }
    // 2026-08-01 ist Samstag, 2026-08-03 ist Montag.
    const sat = byDate.get("2026-08-01") ?? 0;
    const mon = byDate.get("2026-08-03") ?? 0;
    expect(sat).toBeGreaterThan(mon);
  });

  it("plant an jedem offenen Tag mindestens zwei Mitarbeiter 30 Minuten vor Öffnung", () => {
    const holidays = holidaysOf(2026, "BW");
    for (const date of datesOfMonth(2026, 8)) {
      const day = resolveDay(DEFAULT_WORK_HOURS, date, holidays);
      const openingStart = day.blocks[0].startMinutes;
      const openers = shifts.filter((shift) => {
        if (shift.date !== date) return false;
        const firstSegment = shift.segments?.[0];
        return (firstSegment?.startMinutes ?? shift.startMinutes) === openingStart;
      });

      expect(openers.length, date).toBeGreaterThanOrEqual(2);
    }

    expect(DEFAULT_WORK_HOURS.perWeekday.monday[0].startMinutes).toBe(10 * 60 + 30);
    expect(DEFAULT_WORK_HOURS.perWeekday.saturday[0].startMinutes).toBe(11 * 60 + 30);
  });

  it("priorisiert Samstag stärker als Sonntag", () => {
    expect(DAY_WEIGHTS.saturday).toBeGreaterThan(DAY_WEIGHTS.sunday);
    expect(LATE_SHIFT_RATIOS.saturday).toBeGreaterThan(LATE_SHIFT_RATIOS.sunday);
  });

  it("meldet fehlende Öffnungsbesetzung als Validierungsfehler", () => {
    const date = datesOfMonth(2026, 8).find((candidate) => {
      const openingStart = resolveDay(DEFAULT_WORK_HOURS, candidate, holidaysOf(2026, "BW"))
        .blocks[0].startMinutes;
      return shifts.filter(
        (shift) =>
          shift.date === candidate &&
          (shift.segments?.[0]?.startMinutes ?? shift.startMinutes) === openingStart,
      ).length === 2;
    })!;
    const openingStart = resolveDay(DEFAULT_WORK_HOURS, date, holidaysOf(2026, "BW"))
      .blocks[0].startMinutes;
    const opener = shifts.find(
      (shift) =>
        shift.date === date &&
        (shift.segments?.[0]?.startMinutes ?? shift.startMinutes) === openingStart,
    )!;
    const invalid = shifts.filter((shift) => shift.id !== opener.id);

    const result = validateSchedule(SAMPLE_EMPLOYEES, invalid, {
      year: 2026,
      month: 8,
      workHours: DEFAULT_WORK_HOURS,
      holidayState: "BW",
    });

    expect(result.errors.some((error) => error.message.includes("2 nhân viên mở cửa"))).toBe(true);
  });
});

describe("Scheduler – weitere Monate robust", () => {
  it("erzeugt gültige Pläne für Februar (28 Tage)", () => {
    const shifts = generateSchedule({
      year: 2026,
      month: 2,
      workHours: DEFAULT_WORK_HOURS,
      employees: SAMPLE_EMPLOYEES,
    });
    const result = validateSchedule(SAMPLE_EMPLOYEES, shifts);
    expect(result.valid).toBe(true);
  });
});
