import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { StundenzettelPage } from "../../components/StundenzettelPage";
import type { AzubiConfig, Employee, Schedule } from "../../types";
import { withAutomaticAzubiTarget } from "../azubi";
import { DEFAULT_WORK_HOURS } from "../workHours";

function renderAzubi(
  azubi: AzubiConfig,
  showThienlongExtras = true,
  schedulePatch: Partial<Schedule> = {},
): string {
  const employee: Employee = withAutomaticAzubiTarget(
    {
      id: "AZ-PRINT",
      name: "Azubi Test",
      employmentType: "AZUBI",
      targetMinutes: 0,
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
    createElement(StundenzettelPage, { schedule, employee, showThienlongExtras }),
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
    expect(html).toContain("Arbeitsstunden ab 20:00 Uhr");
    expect(html).toContain("Sonntagsstunden");
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

  it("keeps the Thienlong Zuschlag block out of other stores", () => {
    const html = renderAzubi(
      { inSchoolTerm: false, schoolDays: [], monthlyHoursOutOfTerm: 154 },
      false,
    );

    expect(html).not.toContain("Zuschläge");
    expect(html).not.toContain("Sonntagsstunden");
  });

  it("prints configured surcharge rates and bonus-equivalent hours", () => {
    const html = renderAzubi(
      { inSchoolTerm: false, schoolDays: [], monthlyHoursOutOfTerm: 154 },
      true,
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

    expect(html).toContain("Zuschlag 25%: +0,50 h");
    expect(html).toContain("Zuschlag 50%: +2,00 h");
    expect(html).toContain("Zuschlagsstunden gesamt");
    expect(html).toContain("+2,50 h");
  });
});
