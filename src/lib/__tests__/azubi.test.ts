import { describe, expect, it } from "vitest";
import {
  AZUBI_HOURS_OUT_OF_TERM,
  AZUBI_MONTHLY_WARNING_HOURS,
  type AzubiConfig,
  type Employee,
  type Shift,
} from "../../types";
import {
  azubiConfigOf,
  azubiMonthlyHoursNeedWarning,
  azubiMonthlyHoursOutOfTerm,
  azubiMonthlyMinutes,
  DEFAULT_AZUBI_CONFIG,
  DEFAULT_AZUBI_MONTHLY_HOURS_OUT_OF_TERM,
  withAutomaticAzubiTarget,
} from "../azubi";
import { parseIsoDate } from "../demand";
import { generateSchedule } from "../scheduler";
import { validateSchedule } from "../validation";
import { DEFAULT_WORK_HOURS } from "../workHours";

function employeeWithConfig(cfg: AzubiConfig, id = "AZ1"): Employee {
  return withAutomaticAzubiTarget(
    {
      id,
      name: "Azubi",
      employmentType: "AZUBI",
      targetMinutes: 999 * 60,
      azubi: cfg,
    },
    2026,
    8,
  );
}

function minutesPerWeek(shifts: Pick<Shift, "date" | "paidMinutes">[]) {
  const result = new Map<string, number>();
  for (const shift of shifts) {
    const monday = parseIsoDate(shift.date);
    monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
    const key = monday.toISOString().slice(0, 10);
    result.set(key, (result.get(key) ?? 0) + shift.paidMinutes);
  }
  return result;
}

function manualShift(
  employeeId: string,
  id: string,
  date: string,
  paidMinutes: number,
): Shift {
  const pauseMinutes = paidMinutes > 6 * 60 ? 30 : 0;
  const startMinutes = 11 * 60;
  return {
    id,
    employeeId,
    date,
    startMinutes,
    endMinutes: startMinutes + paidMinutes + pauseMinutes,
    pauseMinutes,
    paidMinutes,
    shiftType: "CUSTOM",
    generated: false,
  };
}

describe("Azubi trong kỳ học", () => {
  it("có định mức 0h và không xếp ca", () => {
    const employee = employeeWithConfig({
      inSchoolTerm: true,
      schoolDays: ["monday", "tuesday"],
    });

    expect(azubiMonthlyMinutes(employee.azubi, 2026, 8)).toBe(0);
    expect(employee.targetMinutes).toBe(0);
    expect(
      generateSchedule({
        year: 2026,
        month: 8,
        workHours: DEFAULT_WORK_HOURS,
        employees: [employee],
        holidayState: "BW",
      }),
    ).toEqual([]);
  });

  it("giữ nguyên từ 0 đến 7 ngày học, không giới hạn ở 2 ngày", () => {
    const everyDay: AzubiConfig["schoolDays"] = [
      "monday",
      "tuesday",
      "wednesday",
      "thursday",
      "friday",
      "saturday",
      "sunday",
    ];

    expect(azubiConfigOf({ inSchoolTerm: true, schoolDays: [] }).schoolDays).toEqual([]);
    expect(azubiConfigOf({ inSchoolTerm: true, schoolDays: everyDay }).schoolDays).toEqual(
      everyDay,
    );
  });

  it("validation báo lỗi nếu vẫn có ca đi làm trong kỳ học", () => {
    const employee = employeeWithConfig({
      inSchoolTerm: true,
      schoolDays: [],
    });
    const result = validateSchedule(
      [employee],
      [manualShift(employee.id, "term-shift", "2026-08-05", 4 * 60)],
    );

    expect(result.errors.some((error) => error.message.includes("0h"))).toBe(true);
  });
});

describe("Azubi ngoài kỳ học", () => {
  it("cho chủ đặt trực tiếp giờ theo tháng và không cắt ở 172h", () => {
    const below: AzubiConfig = {
      inSchoolTerm: false,
      schoolDays: [],
      monthlyHoursOutOfTerm: 171.5,
    };
    const warning: AzubiConfig = {
      ...below,
      monthlyHoursOutOfTerm: AZUBI_MONTHLY_WARNING_HOURS,
    };

    expect(azubiMonthlyHoursOutOfTerm(below)).toBe(171.5);
    expect(azubiMonthlyHoursNeedWarning(below)).toBe(false);
    expect(azubiMonthlyHoursNeedWarning(warning)).toBe(true);
    expect(azubiMonthlyMinutes(warning, 2026, 8)).toBe(
      AZUBI_MONTHLY_WARNING_HOURS * 60,
    );
  });

  it("migrate 38,5h/tuần cũ thành 154h/tháng", () => {
    const migrated = azubiConfigOf({
      inSchoolTerm: false,
      schoolDays: ["monday"],
      weeklyHoursInTerm: 24,
      weeklyHoursOutOfTerm: 38.5,
    });

    expect(migrated).toEqual({
      inSchoolTerm: false,
      schoolDays: ["monday"],
      monthlyHoursOutOfTerm: DEFAULT_AZUBI_MONTHLY_HOURS_OUT_OF_TERM,
    });
  });

  it("mặc định ngoài kỳ là 154h/tháng", () => {
    const employee = employeeWithConfig({
      ...DEFAULT_AZUBI_CONFIG,
      inSchoolTerm: false,
    });

    expect(employee.targetMinutes).toBe(DEFAULT_AZUBI_MONTHLY_HOURS_OUT_OF_TERM * 60);
  });

  it("scheduler đạt đúng mức tháng do chủ đặt và giữ trần 38,5h/tuần", () => {
    const employee = employeeWithConfig({
      inSchoolTerm: false,
      schoolDays: [],
      monthlyHoursOutOfTerm: 120,
    });
    const shifts = generateSchedule({
      year: 2026,
      month: 8,
      workHours: DEFAULT_WORK_HOURS,
      employees: [employee],
      holidayState: "BW",
    });

    expect(shifts.reduce((sum, shift) => sum + shift.paidMinutes, 0)).toBe(120 * 60);
    for (const minutes of minutesPerWeek(shifts).values()) {
      expect(minutes).toBeLessThanOrEqual(AZUBI_HOURS_OUT_OF_TERM * 60);
    }
  });

  it("scheduler giữ đúng cấu hình trong cả 12 tháng", () => {
    for (let month = 1; month <= 12; month += 1) {
      const employee = withAutomaticAzubiTarget(
        {
          id: `AZ-${month}`,
          name: "Azubi cả năm",
          employmentType: "AZUBI",
          targetMinutes: 0,
          azubi: {
            inSchoolTerm: false,
            schoolDays: [],
            monthlyHoursOutOfTerm: 140,
          },
        },
        2026,
        month,
      );
      const shifts = generateSchedule({
        year: 2026,
        month,
        workHours: DEFAULT_WORK_HOURS,
        employees: [employee],
        holidayState: "BW",
      });

      expect(shifts.reduce((sum, shift) => sum + shift.paidMinutes, 0)).toBe(140 * 60);
      for (const minutes of minutesPerWeek(shifts).values()) {
        expect(minutes).toBeLessThanOrEqual(AZUBI_HOURS_OUT_OF_TERM * 60);
      }
    }
  });

  it("validation báo lỗi nếu một tuần vượt 38,5h", () => {
    const employee = employeeWithConfig({
      inSchoolTerm: false,
      schoolDays: [],
      monthlyHoursOutOfTerm: 39,
    });
    const result = validateSchedule(
      [employee],
      [
        manualShift(employee.id, "week-1", "2026-08-03", 10 * 60),
        manualShift(employee.id, "week-2", "2026-08-04", 10 * 60),
        manualShift(employee.id, "week-3", "2026-08-05", 10 * 60),
        manualShift(employee.id, "week-4", "2026-08-06", 9 * 60),
      ],
    );

    expect(result.errors.some((error) => error.message.includes("38.5h"))).toBe(true);
  });
});

it("thứ tự Teilzeit và Azubi không làm lịch thay đổi", () => {
  const apprentice = employeeWithConfig(
    {
      inSchoolTerm: false,
      schoolDays: [],
      monthlyHoursOutOfTerm: 40,
    },
    "AZ-ORDER",
  );
  const partTime: Employee = {
    id: "TZ1",
    name: "Teilzeit",
    employmentType: "TEILZEIT",
    targetMinutes: 40 * 60,
  };
  const common = {
    year: 2026,
    month: 8,
    workHours: DEFAULT_WORK_HOURS,
    holidayState: "BW" as const,
    seed: "azubi-order",
  };

  expect(generateSchedule({ ...common, employees: [partTime, apprentice] })).toEqual(
    generateSchedule({ ...common, employees: [apprentice, partTime] }),
  );
});
