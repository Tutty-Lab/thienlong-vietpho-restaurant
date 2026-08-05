import { describe, expect, it } from "vitest";
import { easterSunday, holidaysOf, holidayNames } from "../holidays";
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
    const h = holidaysOf(2026, "BB");
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
    const h = holidaysOf(2026, "BB");
    expect(h.has("2026-06-04")).toBe(false); // Fronleichnam – nicht in Brandenburg
    expect(h.has("2026-11-01")).toBe(false); // Allerheiligen – nicht in Brandenburg
  });

  it("Set und Namen bleiben deckungsgleich", () => {
    for (const year of [2024, 2026, 2027]) {
      expect(holidaysOf(year, "BB").size).toBe(holidayNames(year, "BB").size);
    }
  });
});

describe("Feiertage (Baden-Württemberg – Heidenheim)", () => {
  it("enthält die BW-Feiertage 2026", () => {
    const h = holidaysOf(2026, "BW");
    expect(h.has("2026-01-01")).toBe(true); // Neujahr
    expect(h.has("2026-01-06")).toBe(true); // Heilige Drei Könige (nur BW/BY/ST)
    expect(h.has("2026-04-03")).toBe(true); // Karfreitag
    expect(h.has("2026-04-06")).toBe(true); // Ostermontag
    expect(h.has("2026-05-01")).toBe(true); // Tag der Arbeit
    expect(h.has("2026-05-14")).toBe(true); // Christi Himmelfahrt
    expect(h.has("2026-05-25")).toBe(true); // Pfingstmontag
    expect(h.has("2026-06-04")).toBe(true); // Fronleichnam
    expect(h.has("2026-10-03")).toBe(true); // Deutsche Einheit
    expect(h.has("2026-11-01")).toBe(true); // Allerheiligen
    expect(h.has("2026-12-25")).toBe(true);
    expect(h.has("2026-12-26")).toBe(true);
    expect(h.size).toBe(12);
  });

  it("enthält KEINE reinen Brandenburg-Feiertage", () => {
    const h = holidaysOf(2026, "BW");
    expect(h.has("2026-10-31")).toBe(false); // Reformationstag
    expect(h.has("2026-04-05")).toBe(false); // Ostersonntag
    expect(h.has("2026-05-24")).toBe(false); // Pfingstsonntag
  });

  it("unterscheidet sich wirklich von Brandenburg", () => {
    const bw = holidaysOf(2026, "BW");
    const bb = holidaysOf(2026, "BB");
    const nurBW = [...bw].filter((d) => !bb.has(d));
    const nurBB = [...bb].filter((d) => !bw.has(d));
    expect(nurBW.sort()).toEqual(["2026-01-06", "2026-06-04", "2026-11-01"]);
    expect(nurBB.sort()).toEqual(["2026-04-05", "2026-05-24", "2026-10-31"]);
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
    expect(total).toBe(793 * 60);
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
