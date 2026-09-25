import { describe, expect, it } from "vitest";
import type { Employee, Shift } from "../../types";
import { generateSchedule } from "../scheduler";
import { DEFAULT_WORK_HOURS } from "../workHours";
import { validateSchedule } from "../validation";
import { withAutomaticAzubiTarget } from "../azubi";
import { checkScheduleReadiness } from "../readiness";
import {
  activeDaysInMonth,
  isEmployeeActiveOn,
  prorateForEmploymentPeriod,
  withEmploymentPeriodTarget,
} from "../employmentPeriod";

const azubi = (hours: number) => ({ inSchoolTerm: false, schoolDays: [], monthlyHoursOutOfTerm: hours });
const month = (e: Employee) =>
  withEmploymentPeriodTarget(withAutomaticAzubiTarget(e, 2026, 9), 2026, 9);

describe("Ngày vào làm / nghỉ việc", () => {
  const base: Employee = { id: "x", name: "X", employmentType: "VOLLZEIT", targetMinutes: 168 * 60 };

  it("counts active calendar days and prorates to full hours", () => {
    const e = { ...base, startDate: "2026-09-16" };
    expect(isEmployeeActiveOn(e, "2026-09-15")).toBe(false);
    expect(isEmployeeActiveOn(e, "2026-09-16")).toBe(true);
    expect(activeDaysInMonth(e, 2026, 9)).toBe(15);
    expect(prorateForEmploymentPeriod(168 * 60, e, 2026, 9)).toBe(84 * 60);
    expect(prorateForEmploymentPeriod(168 * 60, { ...base, endDate: "2026-09-10" }, 2026, 9)).toBe(56 * 60);
  });

  it("keeps the full-month hours so the next full month gets them back", () => {
    const sept = month({ ...base, startDate: "2026-09-16" });
    expect(sept.targetMinutes).toBe(84 * 60);
    expect(sept.baseTargetMinutes).toBe(168 * 60);
    const oct = withEmploymentPeriodTarget(sept, 2026, 10);
    expect(oct.targetMinutes).toBe(168 * 60);
    expect(oct.baseTargetMinutes).toBeUndefined();
    // Unverändert => dasselbe Objekt (kein Render-Loop).
    expect(withEmploymentPeriodTarget(oct, 2026, 10)).toBe(oct);
  });

  it("never prorates Azubi hours – the boss enters them for the month", () => {
    const a: Employee = {
      id: "a", name: "A", employmentType: "AZUBI", targetMinutes: 0,
      azubi: azubi(174), fixedDaysOff: ["sunday", "monday"], startDate: "2026-09-16",
    };
    expect(month(a).targetMinutes).toBe(174 * 60);
    const explicit = { ...a, azubi: { ...azubi(174), workMonthHoursByMonth: { "2026-09": 80 } } };
    expect(month(explicit).targetMinutes).toBe(80 * 60);
  });

  it("schedules nobody outside their period and still meets every target", () => {
    const team: Employee[] = [
      { id: "k1", name: "K1", employmentType: "VOLLZEIT", targetMinutes: 168 * 60, workRole: "KITCHEN", fixedDaysOff: ["monday"] },
      { id: "k2", name: "K2", employmentType: "VOLLZEIT", targetMinutes: 168 * 60, workRole: "KITCHEN", fixedDaysOff: ["tuesday"], startDate: "2026-09-16" },
      { id: "k3", name: "K3", employmentType: "VOLLZEIT", targetMinutes: 168 * 60, workRole: "KITCHEN", fixedDaysOff: ["wednesday"] },
      { id: "s1", name: "S1", employmentType: "VOLLZEIT", targetMinutes: 168 * 60, workRole: "SERVICE", fixedDaysOff: ["thursday"], endDate: "2026-09-20" },
      { id: "s2", name: "S2", employmentType: "VOLLZEIT", targetMinutes: 168 * 60, workRole: "SERVICE", fixedDaysOff: ["friday"] },
      { id: "s3", name: "S3", employmentType: "TEILZEIT", targetMinutes: 60 * 60, workRole: "SERVICE" },
      { id: "gone", name: "Gone", employmentType: "TEILZEIT", targetMinutes: 40 * 60, workRole: "SERVICE", endDate: "2026-08-31" },
    ].map((e) => month(e as Employee));
    expect(team.find((e) => e.id === "gone")!.targetMinutes).toBe(0);

    const ctx = { year: 2026, month: 9, storeId: "thienlong", workHours: DEFAULT_WORK_HOURS, holidayState: "BW" as const };
    const shifts: Shift[] = generateSchedule({ ...ctx, employees: team });
    for (const e of team) {
      const mine = shifts.filter((s) => s.employeeId === e.id);
      expect(mine.every((s) => isEmployeeActiveOn(e, s.date)), e.name).toBe(true);
      expect(mine.reduce((sum, s) => sum + s.paidMinutes, 0), e.name).toBe(e.targetMinutes);
    }
    const errors = validateSchedule(team, shifts, ctx).errors.map((x) => x.message);
    expect(errors.filter((m) => m.includes("ngoài thời gian làm việc"))).toEqual([]);

    // Eine Schicht vor dem Eintritt wird gemeldet.
    const early: Shift = { ...shifts.find((s) => s.employeeId === "k1")!, id: "early", employeeId: "k2", date: "2026-09-02" };
    const withEarly = validateSchedule(team, [...shifts.filter((s) => !(s.employeeId === "k2" && s.date === "2026-09-02")), early], ctx);
    expect(withEarly.errors.some((x) => x.message.includes("chưa vào làm"))).toBe(true);
  });

  it("Azubi đi học từ 15/9 (chủ nhập 81h): làm 1–14/9 đúng 5 ngày/tuần, từ 15/9 không có ca", () => {
    const base = {
      id: "az", name: "Azubi", employmentType: "AZUBI", targetMinutes: 0, workRole: "SERVICE",
      fixedDaysOff: ["tuesday", "thursday"], desiredDaysPerWeek: 5,
      azubi: { inSchoolTerm: true, schoolTermStart: "2026-09-15", schoolTermEnd: "2026-12-31", schoolDays: [], monthlyHoursOutOfTerm: 174 },
    } as Employee;
    // Ohne Eingabe: 0 h und die Bereitschaftsprüfung fordert eine Eingabe.
    expect(month(base).targetMinutes).toBe(0);
    expect(
      checkScheduleReadiness([month(base), { ...base, id: "b", name: "B" }], { year: 2026, month: 9 }).issues
        .some((i) => i.includes("hãy nhập giờ")),
    ).toBe(true);
    const a = month({ ...base, azubi: { ...base.azubi!, monthlyHoursByMonth: { "2026-09": 81 } } });
    expect(a.targetMinutes).toBe(81 * 60);

    const team: Employee[] = [
      a,
      { id: "k1", name: "K1", employmentType: "VOLLZEIT", targetMinutes: 168 * 60, workRole: "KITCHEN", fixedDaysOff: ["monday"] },
      { id: "k2", name: "K2", employmentType: "VOLLZEIT", targetMinutes: 168 * 60, workRole: "KITCHEN", fixedDaysOff: ["wednesday"] },
      { id: "s1", name: "S1", employmentType: "VOLLZEIT", targetMinutes: 168 * 60, workRole: "SERVICE", fixedDaysOff: ["friday"] },
      { id: "s2", name: "S2", employmentType: "TEILZEIT", targetMinutes: 80 * 60, workRole: "SERVICE" },
    ];
    const ctx = { year: 2026, month: 9, storeId: "thienlong", workHours: DEFAULT_WORK_HOURS, holidayState: "BW" as const };
    const shifts = generateSchedule({ ...ctx, employees: team });
    const mine = shifts.filter((s) => s.employeeId === "az");
    expect(mine.reduce((sum, s) => sum + s.paidMinutes, 0)).toBe(81 * 60);
    expect(mine.every((s) => s.date < "2026-09-15")).toBe(true);
    // Volle Woche 7.–13.9.: genau 5 Tage (T3 + T5 sind feste Ruhetage).
    expect(mine.filter((s) => s.date >= "2026-09-07" && s.date <= "2026-09-13")).toHaveLength(5);
  });
});
