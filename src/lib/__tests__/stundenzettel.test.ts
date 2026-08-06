import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { StundenzettelPage } from "../../components/StundenzettelPage";
import type { AzubiConfig, Employee, Schedule } from "../../types";
import { withAutomaticAzubiTarget } from "../azubi";
import { DEFAULT_WORK_HOURS } from "../workHours";

function renderAzubi(azubi: AzubiConfig): string {
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
});
