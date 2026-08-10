import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { StundenzettelPage } from "../../components/StundenzettelPage";
import type { AzubiConfig, Employee, Schedule } from "../../types";
import { withAutomaticAzubiTarget } from "../azubi";
import { DEFAULT_WORK_HOURS } from "../workHours";

function renderAzubi(
  azubi: AzubiConfig,
  schedulePatch: Partial<Schedule> = {},
): string {
  const employee: Employee = withAutomaticAzubiTarget(
    {
      id: "AZ-PRINT",
      name: "Azubi Test",
      employmentType: "AZUBI",
      targetMinutes: 0,
      workRole: "SERVICE",
      azubi,
    },
    2026,
    8,
  );
  const schedule: Schedule = {
    companyName: "Testbetrieb",
    holidayState: "BW",
    address: "Teststrasse 1",
    year: 2026,
    month: 8,
    workHours: DEFAULT_WORK_HOURS,
    dateOverrides: [],
    employees: [employee],
    shifts: [],
    ...schedulePatch,
  };

  return renderToStaticMarkup(
    createElement(StundenzettelPage, { schedule, employee }),
  );
}

describe("Stundenaufzeichnung fuer Azubi", () => {
  it("shows the full-month off state", () => {
    const html = renderAzubi({
      inSchoolTerm: true,
      schoolTermStart: "2026-08-01",
      schoolTermEnd: "2026-08-31",
      schoolDays: [],
      monthlyHoursByMonth: { "2026-08": 0 },
    });

    expect(html).toContain("Ausbildung - kein Einsatz");
    expect(html).toContain("Berufsschule");
    expect(html).not.toContain("Einsatzbereich");
    expect(html).not.toContain("Arbeitsstunden ab 20:00 Uhr");
    expect(html).not.toContain("Sonntagsstunden");
  });

  it("shows the full-month work state", () => {
    const html = renderAzubi({
      inSchoolTerm: false,
      schoolDays: [],
      monthlyHoursOutOfTerm: 154,
    });

    expect(html).toContain("Ausbildung - Arbeit");
    expect(html).not.toContain("Berufsschule");
  });

  it("shows the mixed school/work state", () => {
    const html = renderAzubi({
      inSchoolTerm: true,
      schoolTermStart: "2026-08-01",
      schoolTermEnd: "2026-08-25",
      schoolDays: [],
      monthlyHoursByMonth: { "2026-08": 34 },
    });

    expect(html).toContain("Ausbildung - Schule/Arbeit");
    expect(html).toContain("Berufsschule");
  });

  it("does not calculate or list Zuschlaege for Azubi", () => {
    const html = renderAzubi({
      inSchoolTerm: false,
      schoolDays: [],
      monthlyHoursOutOfTerm: 154,
    });

    expect(html).not.toContain("Zuschläge");
  });

  it("does not print configured surcharge rates for Azubi", () => {
    const html = renderAzubi(
      { inSchoolTerm: false, schoolDays: [], monthlyHoursOutOfTerm: 154 },
      {
        surchargeConfig: { after20Percent: 25, sundayPercent: 50 },
        shifts: [
          {
            id: "sunday-late",
            employeeId: "AZ-PRINT",
            date: "2026-08-02",
            startMinutes: 18 * 60,
            endMinutes: 22 * 60,
            pauseMinutes: 0,
            paidMinutes: 4 * 60,
            shiftType: "LATE",
            generated: true,
          },
        ],
      },
    );

    expect(html).not.toContain("Zuschlag 25%");
    expect(html).not.toContain("Zuschlag 50%");
    expect(html).not.toContain("Zuschlagsstunden gesamt");
  });

  it("keeps Zuschlaege for regular employees without double-counting Sunday Nacht hours", () => {
    const employee: Employee = {
      id: "REGULAR-PRINT",
      name: "Regular Test",
      employmentType: "VOLLZEIT",
      targetMinutes: 160 * 60,
      workRole: "KITCHEN",
    };
    const schedule: Schedule = {
      companyName: "Testbetrieb",
      holidayState: "BW",
      address: "Teststrasse 1",
      year: 2026,
      month: 8,
      workHours: DEFAULT_WORK_HOURS,
      surchargeConfig: { after20Percent: 25, sundayPercent: 50 },
      dateOverrides: [],
      employees: [employee],
      shifts: [
        {
          id: "saturday-late",
          employeeId: employee.id,
          date: "2026-08-01",
          startMinutes: 20 * 60,
          endMinutes: 22 * 60,
          pauseMinutes: 0,
          paidMinutes: 2 * 60,
          shiftType: "LATE",
          generated: true,
        },
        {
          id: "sunday-late",
          employeeId: employee.id,
          date: "2026-08-02",
          startMinutes: 20 * 60,
          endMinutes: 22 * 60,
          pauseMinutes: 0,
          paidMinutes: 2 * 60,
          shiftType: "LATE",
          generated: true,
        },
      ],
    };

    const html = renderToStaticMarkup(
      createElement(StundenzettelPage, { schedule, employee }),
    );

    expect(html).toContain("Zuschläge");
    expect(html).toContain("Zuschlag 25%: +0,50 h");
    expect(html).toContain("Zuschlag 50%: +1,00 h");
    expect(html).toContain("+1,50 h");
    expect(html).not.toContain("Einsatzbereich");
  });
});
