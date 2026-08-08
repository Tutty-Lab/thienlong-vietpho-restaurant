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
  azubiMonthKey,
  azubiMonthMode,
  azubiMonthlyHoursForMonth,
  azubiMonthlyHoursNeedWarning,
  azubiMonthlyHoursOverride,
  azubiMonthlyHoursOutOfTerm,
  azubiMonthlyMinutes,
  azubiTimesheetMode,
  DEFAULT_AZUBI_CONFIG,
  DEFAULT_AZUBI_MONTHLY_HOURS_OUT_OF_TERM,
  isAzubiSchoolDate,
  isAzubiSchoolTermDate,
  withAutomaticAzubiTarget,
} from "../azubi";
import { parseIsoDate } from "../demand";
import { generateSchedule } from "../scheduler";
import { validateSchedule } from "../validation";
import { DEFAULT_WORK_HOURS } from "../workHours";

function employeeWithConfig(
  cfg: AzubiConfig,
  id = "AZ1",
  year = 2026,
  month = 8,
): Employee {
  return withAutomaticAzubiTarget(
    {
      id,
      name: "Azubi",
      employmentType: "AZUBI",
      targetMinutes: 999 * 60,
      azubi: cfg,
    },
    year,
    month,
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

  it("scheduler bỏ qua ngày học cũ khi tháng được nhập giờ làm", () => {
    const employee = employeeWithConfig({
      inSchoolTerm: true,
      schoolTermStart: "2026-08-01",
      schoolTermEnd: "2026-08-31",
      schoolDays: [
        "monday",
        "tuesday",
        "wednesday",
        "thursday",
        "friday",
        "saturday",
        "sunday",
      ],
      monthlyHoursByMonth: { "2026-08": 40 },
    });
    const shifts = generateSchedule({
      year: 2026,
      month: 8,
      workHours: DEFAULT_WORK_HOURS,
      employees: [employee],
      holidayState: "BW",
    });

    expect(shifts.reduce((sum, shift) => sum + shift.paidMinutes, 0)).toBe(40 * 60);
  });

  it("ngày học cũ không còn chặn ca khi tháng có giờ làm", () => {
    const employee = employeeWithConfig({
      inSchoolTerm: true,
      schoolDays: ["wednesday"],
      monthlyHoursByMonth: { "2026-08": 40 },
    });
    const result = validateSchedule(
      [employee],
      [manualShift(employee.id, "term-shift", "2026-08-05", 4 * 60)],
    );

    expect(result.errors.some((error) => error.message.includes("ngày đi học"))).toBe(false);
  });

  it("migrate dữ liệu cũ không có ngày thành kỳ học trọn tháng", () => {
    const legacy = { inSchoolTerm: true, schoolDays: ["monday"] } satisfies AzubiConfig;

    expect(azubiMonthMode(legacy, 2026, 8)).toBe("school");
    expect(isAzubiSchoolTermDate(legacy, "2026-08-15")).toBe(true);
    expect(isAzubiSchoolDate(legacy, "2026-08-17")).toBe(false);
    expect(isAzubiSchoolDate(legacy, "2026-08-15")).toBe(false);
    expect(azubiMonthlyMinutes(legacy, 2026, 8)).toBe(0);
  });
});

describe("Azubi có kỳ học theo khoảng ngày", () => {
  const ranged: AzubiConfig = {
    inSchoolTerm: true,
    schoolTermStart: "2026-06-25",
    schoolTermEnd: "2026-08-25",
    schoolDays: ["monday", "tuesday"],
    monthlyHoursOutOfTerm: 154,
    monthlyHoursByMonth: {
      "2026-06": 48,
      "2026-07": 80,
      "2026-08": 30,
    },
  };

  it("tính đúng tháng làm, tháng học và tháng lẫn học/làm", () => {
    expect(azubiMonthMode(ranged, 2026, 5)).toBe("work");
    expect(azubiMonthMode(ranged, 2026, 6)).toBe("mixed");
    expect(azubiMonthMode(ranged, 2026, 7)).toBe("school");
    expect(azubiMonthMode(ranged, 2026, 8)).toBe("mixed");
    expect(azubiMonthMode(ranged, 2026, 9)).toBe("work");

    expect(azubiMonthlyMinutes(ranged, 2026, 6)).toBe(48 * 60);
    expect(azubiMonthlyMinutes(ranged, 2026, 7)).toBe(80 * 60);
    expect(azubiMonthlyMinutes(ranged, 2026, 8)).toBe(30 * 60);
    expect(azubiMonthlyMinutes(ranged, 2026, 9)).toBe(154 * 60);
  });

  it("dùng giờ chủ nhập riêng cho từng tháng, không tự chia theo tỷ lệ ngày", () => {
    const withoutOverrides: AzubiConfig = {
      ...ranged,
      monthlyHoursByMonth: undefined,
    };

    expect(azubiMonthKey(2026, 6)).toBe("2026-06");
    expect(azubiMonthlyHoursOverride(ranged, 2026, 6)).toBe(48);
    expect(azubiMonthlyHoursForMonth(ranged, 2026, 7)).toBe(80);
    expect(azubiMonthlyHoursForMonth(ranged, 2026, 8)).toBe(30);
    expect(azubiMonthlyHoursForMonth(withoutOverrides, 2026, 6)).toBe(0);
    expect(azubiMonthlyHoursForMonth(withoutOverrides, 2026, 8)).toBe(0);
  });

  it("chuẩn hoá giờ từng tháng theo bước 0,5h và cảnh báo theo đúng tháng", () => {
    const normalized = azubiConfigOf({
      ...ranged,
      monthlyHoursByMonth: {
        "2026-06": 24.26,
        "2026-08": AZUBI_MONTHLY_WARNING_HOURS + 0.5,
        "không-hợp-lệ": 50,
      },
    });

    expect(normalized.monthlyHoursByMonth).toEqual({
      "2026-06": 24.5,
      "2026-08": AZUBI_MONTHLY_WARNING_HOURS + 0.5,
    });
    expect(azubiMonthlyHoursNeedWarning(normalized, 2026, 6)).toBe(false);
    expect(azubiMonthlyHoursNeedWarning(normalized, 2026, 8)).toBe(true);
  });

  it("scheduler xếp đủ giờ từng tháng và bỏ qua cấu hình ngày học cũ", () => {
    for (const month of [6, 7, 8]) {
      const employee = employeeWithConfig(ranged, `AZ-RANGE-${month}`, 2026, month);
      const shifts = generateSchedule({
        year: 2026,
        month,
        workHours: DEFAULT_WORK_HOURS,
        employees: [employee],
        holidayState: "BW",
      });

      expect(shifts.reduce((sum, shift) => sum + shift.paidMinutes, 0)).toBe(
        employee.targetMinutes,
      );
    }
  });

  it("validation không phụ thuộc ngày học cũ trong hoặc ngoài kỳ", () => {
    const employee = employeeWithConfig(ranged);
    const result = validateSchedule(
      [employee],
      [
        manualShift(employee.id, "before-term", "2026-06-24", 4 * 60),
        manualShift(employee.id, "term-work-day", "2026-06-25", 4 * 60),
        manualShift(employee.id, "term-school-day", "2026-06-29", 4 * 60),
      ],
    );

    expect(result.errors.some((error) => error.date === "2026-06-29")).toBe(false);
    expect(result.errors.some((error) => error.date === "2026-06-25")).toBe(false);
    expect(result.errors.some((error) => error.date === "2026-06-24")).toBe(false);
  });
});

describe("Azubi ngoài kỳ học", () => {
  it("cho chủ đặt trực tiếp giờ theo tháng và chỉ cảnh báo khi vượt 174h", () => {
    const below: AzubiConfig = {
      inSchoolTerm: false,
      schoolDays: [],
      monthlyHoursOutOfTerm: 173.5,
    };
    const atLimit: AzubiConfig = {
      ...below,
      monthlyHoursOutOfTerm: AZUBI_MONTHLY_WARNING_HOURS,
    };
    const warning: AzubiConfig = {
      ...below,
      monthlyHoursOutOfTerm: AZUBI_MONTHLY_WARNING_HOURS + 0.5,
    };

    expect(azubiMonthlyHoursOutOfTerm(below)).toBe(173.5);
    expect(azubiMonthlyHoursNeedWarning(below)).toBe(false);
    expect(azubiMonthlyHoursNeedWarning(atLimit)).toBe(false);
    expect(azubiMonthlyHoursNeedWarning(warning)).toBe(true);
    expect(azubiMonthlyMinutes(atLimit, 2026, 8)).toBe(
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

  it("không tạo ca Azubi dưới 3h khi tổng tháng từ 3h trở lên", () => {
    const employee = employeeWithConfig({
      inSchoolTerm: true,
      schoolTermStart: "2026-08-01",
      schoolTermEnd: "2026-08-31",
      schoolDays: ["monday", "tuesday"],
      monthlyHoursByMonth: { "2026-08": 30 },
    });
    const shifts = generateSchedule({
      year: 2026,
      month: 8,
      workHours: DEFAULT_WORK_HOURS,
      employees: [employee],
      holidayState: "BW",
      seed: "audit-three-month-term-8",
    });

    expect(Math.min(...shifts.map((shift) => shift.paidMinutes))).toBeGreaterThanOrEqual(
      3 * 60,
    );
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

describe("Trạng thái Azubi trên bản in và PDF", () => {
  it("phân biệt nghỉ cả tháng, làm cả tháng và học/làm", () => {
    expect(
      azubiTimesheetMode(
        {
          inSchoolTerm: true,
          schoolTermStart: "2026-08-01",
          schoolTermEnd: "2026-08-31",
          schoolDays: [],
          monthlyHoursByMonth: { "2026-08": 0 },
        },
        2026,
        8,
      ),
    ).toBe("off");

    expect(
      azubiTimesheetMode(
        {
          inSchoolTerm: false,
          schoolDays: [],
          monthlyHoursOutOfTerm: 154,
        },
        2026,
        8,
      ),
    ).toBe("work");

    expect(
      azubiTimesheetMode(
        {
          inSchoolTerm: true,
          schoolTermStart: "2026-08-01",
          schoolTermEnd: "2026-08-31",
          schoolDays: [],
          monthlyHoursByMonth: { "2026-08": 34 },
        },
        2026,
        8,
      ),
    ).toBe("mixed");
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

it("ba Azubi cùng định mức không lệch nhau quá một ca trong cùng tuần", () => {
  const employees = ["AZ-I1", "AZ-I2", "AZ-I3"].map((id) =>
    employeeWithConfig(
      {
        inSchoolTerm: true,
        schoolTermStart: "2026-08-01",
        schoolTermEnd: "2026-08-31",
        schoolDays: [],
        monthlyHoursByMonth: { "2026-08": 80 },
      },
      id,
    ),
  );
  const shifts = generateSchedule({
    year: 2026,
    month: 8,
    workHours: DEFAULT_WORK_HOURS,
    employees,
    holidayState: "BW",
    seed: "audit-three-identical-azubis",
  });
  const byEmployee = new Map(
    employees.map((employee) => [
      employee.id,
      minutesPerWeek(shifts.filter((shift) => shift.employeeId === employee.id)),
    ]),
  );
  const weeks = new Set(
    [...byEmployee.values()].flatMap((weekly) => [...weekly.keys()]),
  );

  for (const week of weeks) {
    const totals = employees.map(
      (employee) => byEmployee.get(employee.id)?.get(week) ?? 0,
    );
    expect(Math.max(...totals) - Math.min(...totals)).toBeLessThanOrEqual(10 * 60);
  }
});
