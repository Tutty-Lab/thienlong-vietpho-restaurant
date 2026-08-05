import { describe, expect, it } from "vitest";
import { easterSunday, brandenburgHolidays, brandenburgHolidayNames } from "../holidays";
import { generateSchedule } from "../scheduler";
import { validateSchedule } from "../validation";
import { DEFAULT_WORK_HOURS } from "../workHours";
import { SAMPLE_EMPLOYEES } from "../sampleData";
import { format } from "date-fns";

describe("Feiertage (Brandenburg)", () => {
  it("berechnet Ostersonntag korrekt", () => {
    expect(format(easterSunday(2026), "yyyy-MM-dd")).toBe("2026-04-05");
    expect(format(easterSunday(2024), "yyyy-MM-dd")).toBe("2024-03-31");
  });

  it("enthält die festen und beweglichen Brandenburg-Feiertage 2026", () => {
    const h = brandenburgHolidays(2026);
    expect(h.has("2026-01-01")).toBe(true); // Neujahr
    expect(h.has("2026-04-03")).toBe(true); // Karfreitag
    expect(h.has("2026-04-05")).toBe(true); // Ostersonntag (Brandenburg)
    expect(h.has("2026-04-06")).toBe(true); // Ostermontag
    expect(h.has("2026-05-01")).toBe(true); // Tag der Arbeit
    expect(h.has("2026-05-14")).toBe(true); // Christi Himmelfahrt
    expect(h.has("2026-05-24")).toBe(true); // Pfingstsonntag (Brandenburg)
    expect(h.has("2026-05-25")).toBe(true); // Pfingstmontag
    expect(h.has("2026-10-03")).toBe(true); // Deutsche Einheit
    expect(h.has("2026-10-31")).toBe(true); // Reformationstag (Brandenburg)
    expect(h.has("2026-12-25")).toBe(true);
    expect(h.has("2026-12-26")).toBe(true);
    expect(h.size).toBe(12);
  });

  it("enthält KEINE reinen NRW-Feiertage", () => {
    const h = brandenburgHolidays(2026);
    expect(h.has("2026-06-04")).toBe(false); // Fronleichnam – nicht in Brandenburg
    expect(h.has("2026-11-01")).toBe(false); // Allerheiligen – nicht in Brandenburg
  });

  it("Set und Namen bleiben deckungsgleich", () => {
    for (const year of [2024, 2026, 2027]) {
      expect(brandenburgHolidays(year).size).toBe(brandenburgHolidayNames(year).size);
    }
  });
});

describe("Scheduler mit Feiertagen (Dezember 2026)", () => {
  it("bleibt gültig und trifft jedes Soll exakt", () => {
    const shifts = generateSchedule({
      year: 2026,
      month: 12, // enthält 1. und 2. Weihnachtstag
      workHours: DEFAULT_WORK_HOURS,
      employees: SAMPLE_EMPLOYEES,
    });
    const result = validateSchedule(SAMPLE_EMPLOYEES, shifts);
    expect(result.valid).toBe(true);
    const total = shifts.reduce((s, x) => s + x.paidMinutes, 0);
    expect(total).toBe(1022 * 60);
  });

  it("plant Schichten an Feiertagen im 11:00–22:00-Fenster", () => {
    const shifts = generateSchedule({
      year: 2026,
      month: 12,
      workHours: DEFAULT_WORK_HOURS,
      employees: SAMPLE_EMPLOYEES,
    });
    // 25.12. ist Feiertag -> eigenes Fenster: frühester Beginn 11:00 (660).
    const xmas = shifts.filter((s) => s.date === "2026-12-25");
    for (const s of xmas) {
      expect(s.startMinutes).toBeGreaterThanOrEqual(11 * 60);
      expect(s.endMinutes).toBeLessThanOrEqual(22 * 60);
    }
  });
});
