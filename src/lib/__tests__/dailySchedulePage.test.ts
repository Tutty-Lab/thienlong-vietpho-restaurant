import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DailySchedulePage } from "../../components/DailySchedulePage";
import type { Employee, Schedule } from "../../types";
import { DEFAULT_WORK_HOURS } from "../workHours";

const employees: Employee[] = [
  {
    id: "KITCHEN-1",
    name: "Lan Küche",
    employmentType: "VOLLZEIT",
    targetMinutes: 9_600,
    workRole: "KITCHEN",
  },
  {
    id: "SERVICE-1",
    name: "Minh Service",
    employmentType: "TEILZEIT",
    targetMinutes: 6_000,
    workRole: "SERVICE",
  },
  {
    id: "FREE-1",
    name: "An Frei",
    employmentType: "AZUBI",
    targetMinutes: 0,
    workRole: "SERVICE",
  },
];

const schedule: Schedule = {
  companyName: "Thien Long Restaurant",
  address: "Musterstrasse 10",
  holidayState: "BW",
  year: 2026,
  month: 8,
  workHours: DEFAULT_WORK_HOURS,
  surchargeConfig: { after20Percent: 25, sundayPercent: 50 },
  dateOverrides: [],
  employees,
  shifts: [
    {
      id: "SHIFT-KITCHEN",
      employeeId: "KITCHEN-1",
      date: "2026-08-08",
      startMinutes: 630,
      endMinutes: 1_320,
      pauseMinutes: 0,
      segments: [
        { startMinutes: 630, endMinutes: 900 },
        { startMinutes: 990, endMinutes: 1_320 },
      ],
      paidMinutes: 600,
      shiftType: "CUSTOM",
      generated: true,
    },
    {
      id: "SHIFT-SERVICE",
      employeeId: "SERVICE-1",
      date: "2026-08-08",
      startMinutes: 1_080,
      endMinutes: 1_320,
      pauseMinutes: 0,
      paidMinutes: 240,
      shiftType: "LATE",
      generated: true,
    },
    {
      id: "SHIFT-NEXT-DAY",
      employeeId: "KITCHEN-1",
      date: "2026-08-09",
      startMinutes: 1_335,
      endMinutes: 1_380,
      pauseMinutes: 0,
      paidMinutes: 45,
      shiftType: "LATE",
      generated: true,
    },
  ],
};

function render(date: string): string {
  return renderToStaticMarkup(createElement(DailySchedulePage, { schedule, date }));
}

describe("DailySchedulePage", () => {
  it("renders the complete roster and only shifts from the selected date", () => {
    const html = render("2026-08-08");

    expect(html).toContain("Tagesdienstplan");
    expect(html).toContain("Firmenname");
    expect(html).toContain("Wochentag");
    expect(html).toContain("Samstag");
    expect(html).toContain("08.08.2026");
    expect(html).toContain("Lan Küche");
    expect(html).toContain("10:30–15:00");
    expect(html).toContain("16:30–22:00");
    expect(html).toContain("An Frei");
    expect(html).toContain("Frei");
    expect(html).not.toContain("22:15");
  });

  it("summarizes staff and hours by restaurant role", () => {
    const html = render("2026-08-08");

    expect(html).toContain("14,00 h");
    expect(html).toContain("1 Pers. · 10,00 h");
    expect(html).toContain("1 Pers. · 4,00 h");
    expect(html).toContain("Geteilter Dienst");
    expect(html).toContain("Spätdienst");
    expect(html).toContain("Erstellt von");
    expect(html).toContain("Zuschläge");
    expect(html).toContain("Ab 20:00");
    expect(html).toContain("+1,00 h");
  });

  it("includes Sunday surcharge hours in the selected day's export", () => {
    const html = render("2026-08-09");

    expect(html).toContain("Sonntag");
    expect(html).toContain("0,75 h");
    expect(html).toContain("50%: +0,38 h");
  });

  it("keeps the daily export compact when no surcharge hours exist", () => {
    const html = render("2026-08-10");

    expect(html).not.toContain("Zuschläge");
  });
});
