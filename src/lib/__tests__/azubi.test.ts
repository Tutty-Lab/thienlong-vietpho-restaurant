import { describe, expect, it } from "vitest";
import { generateSchedule } from "../scheduler";
import { DEFAULT_WORK_HOURS } from "../workHours";
import { weekdayKeyOf, parseIsoDate } from "../demand";
import {
  AZUBI_HOURS_IN_TERM,
  AZUBI_HOURS_OUT_OF_TERM,
  AZUBI_WORKDAYS_IN_TERM,
  type AzubiConfig,
  type Employee,
  type Shift,
} from "../../types";
import {
  azubiConfiguredWeeklyHours,
  azubiEffectiveWeeklyHours,
  azubiExceedsWeeklyMaximum,
  azubiMonthlyMinutes,
  azubiWeeklyHours,
  DEFAULT_AZUBI_CONFIG,
  withAutomaticAzubiTarget,
} from "../azubi";
import { validateSchedule } from "../validation";

const azubi = (hours: number, inSchoolTerm: boolean, schoolDays: Employee["azubi"] extends
  | { schoolDays: infer D }
  | undefined
  ? D
  : never): Employee => ({
  id: "AZ1",
  name: "Azubi",
  employmentType: "AZUBI",
  targetMinutes: hours * 60,
  azubi: { inSchoolTerm, schoolDays },
});

/** Minuten je Kalenderwoche (Montag als Schlüssel). */
function perWeek(shifts: { date: string; paidMinutes: number }[]) {
  const m = new Map<string, number>();
  for (const s of shifts) {
    const d = parseIsoDate(s.date);
    d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
    const k = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
      d.getDate(),
    ).padStart(2, "0")}`;
    m.set(k, (m.get(k) ?? 0) + s.paidMinutes);
  }
  return m;
}

function workdaysPerWeek(shifts: { date: string }[]) {
  const result = new Map<string, Set<string>>();
  for (const shift of shifts) {
    const date = parseIsoDate(shift.date);
    date.setDate(date.getDate() - ((date.getDay() + 6) % 7));
    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(
      date.getDate(),
    ).padStart(2, "0")}`;
    const workdays = result.get(key) ?? new Set<string>();
    workdays.add(shift.date);
    result.set(key, workdays);
  }
  return result;
}

function manualShift(id: string, date: string, paidMinutes: number): Shift {
  const pauseMinutes = paidMinutes > 6 * 60 ? 30 : 0;
  const startMinutes = 11 * 60;
  return {
    id,
    employeeId: "AZ-VALIDATE",
    date,
    startMinutes,
    endMinutes: startMinutes + paidMinutes + pauseMinutes,
    pauseMinutes,
    paidMinutes,
    shiftType: "CUSTOM",
    generated: false,
  };
}

describe("Azubi định mức tự động", () => {
  it("mặc định dùng kỳ học và tính theo các tuần nằm trong tháng", () => {
    expect(azubiWeeklyHours(undefined)).toBe(AZUBI_HOURS_IN_TERM);
    expect(azubiMonthlyMinutes(DEFAULT_AZUBI_CONFIG, 2026, 9)).toBe(104 * 60);
  });

  it("không tạo định mức vượt sức chứa khi tháng kết thúc bằng 2 ngày học", () => {
    const employee = withAutomaticAzubiTarget(
      {
        id: "AZ-BOUNDARY",
        name: "Azubi Boundary",
        employmentType: "AZUBI",
        targetMinutes: 0,
        azubi: DEFAULT_AZUBI_CONFIG,
      },
      2026,
      6,
    );

    expect(employee.targetMinutes).toBe(96 * 60);
    expect(() =>
      generateSchedule({
        year: 2026,
        month: 6,
        workHours: DEFAULT_WORK_HOURS,
        employees: [employee],
        holidayState: "BW",
      }),
    ).not.toThrow();
  });

  it("ngoài kỳ học hỗ trợ cả nửa giờ", () => {
    expect(azubiMonthlyMinutes({ inSchoolTerm: false, schoolDays: [] }, 2026, 7)).toBe(
      170.5 * 60,
    );
  });

  it("cho phép chủ đặt thấp hơn mức tối đa", () => {
    const cfg: AzubiConfig = {
      inSchoolTerm: true,
      schoolDays: ["monday", "tuesday"],
      weeklyHoursInTerm: 18,
      weeklyHoursOutOfTerm: 30,
    };

    expect(azubiConfiguredWeeklyHours(cfg, true)).toBe(18);
    expect(azubiEffectiveWeeklyHours(cfg, true)).toBe(18);
    expect(azubiEffectiveWeeklyHours(cfg, false)).toBe(30);
    expect(azubiMonthlyMinutes(cfg, 2026, 9)).toBe(78 * 60);
  });

  it("cảnh báo và giới hạn nếu chủ đặt 25h trong kỳ học", () => {
    const cfg: AzubiConfig = {
      inSchoolTerm: true,
      schoolDays: ["monday", "tuesday"],
      weeklyHoursInTerm: 25,
      weeklyHoursOutOfTerm: 38.5,
    };

    expect(azubiExceedsWeeklyMaximum(cfg, true)).toBe(true);
    expect(azubiConfiguredWeeklyHours(cfg, true)).toBe(25);
    expect(azubiEffectiveWeeklyHours(cfg, true)).toBe(AZUBI_HOURS_IN_TERM);
    expect(azubiMonthlyMinutes(cfg, 2026, 9)).toBe(104 * 60);
  });

  it("cảnh báo và giới hạn nếu chủ đặt quá 38,5h ngoài kỳ học", () => {
    const cfg: AzubiConfig = {
      inSchoolTerm: false,
      schoolDays: [],
      weeklyHoursInTerm: 24,
      weeklyHoursOutOfTerm: 40,
    };

    expect(azubiExceedsWeeklyMaximum(cfg, false)).toBe(true);
    expect(azubiConfiguredWeeklyHours(cfg, false)).toBe(40);
    expect(azubiEffectiveWeeklyHours(cfg, false)).toBe(AZUBI_HOURS_OUT_OF_TERM);
    expect(azubiMonthlyMinutes(cfg, 2026, 7)).toBe(170.5 * 60);
  });

  it("ghi đè định mức nhập tay cũ và thêm cấu hình mặc định", () => {
    const employee = withAutomaticAzubiTarget(
      {
        id: "AZ-AUTO",
        name: "Azubi Auto",
        employmentType: "AZUBI",
        targetMinutes: 1,
      },
      2026,
      9,
    );

    expect(employee.azubi).toEqual(DEFAULT_AZUBI_CONFIG);
    expect(employee.targetMinutes).toBe(104 * 60);
  });

  it("scheduler đạt chính xác định mức tự động trong kỳ học", () => {
    const employee = withAutomaticAzubiTarget(
      {
        id: "AZ-MONTHLY",
        name: "Azubi Monthly",
        employmentType: "AZUBI",
        targetMinutes: 0,
        azubi: { inSchoolTerm: true, schoolDays: ["monday", "tuesday"] },
      },
      2026,
      9,
    );
    const shifts = generateSchedule({
      year: 2026,
      month: 9,
      workHours: DEFAULT_WORK_HOURS,
      employees: [employee],
      holidayState: "BW",
    });

    expect(shifts.reduce((sum, shift) => sum + shift.paidMinutes, 0)).toBe(
      employee.targetMinutes,
    );
    for (const [, minutes] of perWeek(shifts)) {
      expect(minutes).toBeLessThanOrEqual(AZUBI_HOURS_IN_TERM * 60);
    }
    for (const [, workdays] of workdaysPerWeek(shifts)) {
      expect(workdays.size).toBeLessThanOrEqual(AZUBI_WORKDAYS_IN_TERM);
    }
  });

  it("scheduler chia mức thấp hơn trên 3 ngày của tuần đầy đủ", () => {
    const employee = withAutomaticAzubiTarget(
      {
        id: "AZ-18",
        name: "Azubi 18h",
        employmentType: "AZUBI",
        targetMinutes: 0,
        azubi: {
          inSchoolTerm: true,
          schoolDays: ["monday", "tuesday"],
          weeklyHoursInTerm: 18,
          weeklyHoursOutOfTerm: 30,
        },
      },
      2026,
      9,
    );
    const shifts = generateSchedule({
      year: 2026,
      month: 9,
      workHours: DEFAULT_WORK_HOURS,
      employees: [employee],
      holidayState: "BW",
    });

    expect(shifts.reduce((sum, shift) => sum + shift.paidMinutes, 0)).toBe(78 * 60);
    for (const [, minutes] of perWeek(shifts)) {
      expect(minutes).toBeLessThanOrEqual(18 * 60);
    }
    for (const [, workdays] of workdaysPerWeek(shifts)) {
      expect(workdays.size).toBeLessThanOrEqual(AZUBI_WORKDAYS_IN_TERM);
    }
    expect(workdaysPerWeek(shifts).get("2026-09-07")?.size).toBe(AZUBI_WORKDAYS_IN_TERM);
    expect(workdaysPerWeek(shifts).get("2026-09-14")?.size).toBe(AZUBI_WORKDAYS_IN_TERM);
    expect(workdaysPerWeek(shifts).get("2026-09-21")?.size).toBe(AZUBI_WORKDAYS_IN_TERM);
  });

  it("giữ đúng các giới hạn Azubi trong cả 12 tháng", () => {
    for (let month = 1; month <= 12; month += 1) {
      for (const inSchoolTerm of [true, false]) {
        const employee = withAutomaticAzubiTarget(
          {
            id: `AZ-${month}-${inSchoolTerm}`,
            name: "Azubi cả năm",
            employmentType: "AZUBI",
            targetMinutes: 0,
            azubi: {
              inSchoolTerm,
              schoolDays: ["monday", "tuesday"],
              weeklyHoursInTerm: 20,
              weeklyHoursOutOfTerm: 35,
            },
          },
          2026,
          month,
        );
        let shifts: Shift[];
        try {
          shifts = generateSchedule({
            year: 2026,
            month,
            workHours: DEFAULT_WORK_HOURS,
            employees: [employee],
            holidayState: "BW",
          });
        } catch (error) {
          throw new Error(
            `Tháng ${month}, kỳ học=${inSchoolTerm}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }

        expect(shifts.reduce((sum, shift) => sum + shift.paidMinutes, 0)).toBe(
          employee.targetMinutes,
        );
        for (const [, minutes] of perWeek(shifts)) {
          expect(minutes).toBeLessThanOrEqual((inSchoolTerm ? 20 : 35) * 60);
        }
        if (inSchoolTerm) {
          for (const shift of shifts) {
            expect(["monday", "tuesday"]).not.toContain(
              weekdayKeyOf(parseIsoDate(shift.date)),
            );
          }
          for (const [, workdays] of workdaysPerWeek(shifts)) {
            expect(workdays.size).toBeLessThanOrEqual(AZUBI_WORKDAYS_IN_TERM);
          }
        }
      }
    }
  });
});

describe("Azubi trong kỳ học", () => {
  const emp = withAutomaticAzubiTarget(
    azubi(1, true, ["monday", "tuesday"]),
    2026,
    9,
  );
  const shifts = generateSchedule({
    year: 2026,
    month: 9,
    workHours: DEFAULT_WORK_HOURS,
    employees: [emp],
    holidayState: "BW",
  });

  it("không xếp ca vào ngày đi học", () => {
    for (const s of shifts) {
      const key = weekdayKeyOf(parseIsoDate(s.date));
      expect(["monday", "tuesday"]).not.toContain(key);
    }
  });

  it(`không tuần nào vượt ${AZUBI_HOURS_IN_TERM}h`, () => {
    for (const [, minutes] of perWeek(shifts)) {
      expect(minutes).toBeLessThanOrEqual(AZUBI_HOURS_IN_TERM * 60);
    }
  });

  it(`không tuần nào vượt ${AZUBI_WORKDAYS_IN_TERM} ngày làm`, () => {
    for (const [, workdays] of workdaysPerWeek(shifts)) {
      expect(workdays.size).toBeLessThanOrEqual(AZUBI_WORKDAYS_IN_TERM);
    }
  });

  it("vẫn đạt đúng định mức tháng", () => {
    const total = shifts.reduce((a, s) => a + s.paidMinutes, 0);
    expect(total).toBe(emp.targetMinutes);
  });
});

describe("Azubi ngoài kỳ học", () => {
  const emp = withAutomaticAzubiTarget(azubi(1, false, []), 2026, 7);
  const shifts = generateSchedule({
    year: 2026,
    month: 7,
    workHours: DEFAULT_WORK_HOURS,
    employees: [emp],
    holidayState: "BW",
  });

  it("được xếp cả tuần, không có ngày học", () => {
    const days = new Set(shifts.map((s) => weekdayKeyOf(parseIsoDate(s.date))));
    expect(days.size).toBeGreaterThan(2);
  });

  it(`không tuần nào vượt ${AZUBI_HOURS_OUT_OF_TERM}h`, () => {
    for (const [, minutes] of perWeek(shifts)) {
      expect(minutes).toBeLessThanOrEqual(AZUBI_HOURS_OUT_OF_TERM * 60);
    }
  });

  it("đạt đúng định mức tháng", () => {
    expect(shifts.reduce((a, s) => a + s.paidMinutes, 0)).toBe(emp.targetMinutes);
  });

  it("chia lịch theo mức thấp hơn do chủ đặt", () => {
    const configured = withAutomaticAzubiTarget(
      {
        id: "AZ-30",
        name: "Azubi 30h",
        employmentType: "AZUBI",
        targetMinutes: 0,
        azubi: {
          inSchoolTerm: false,
          schoolDays: [],
          weeklyHoursInTerm: 20,
          weeklyHoursOutOfTerm: 30,
        },
      },
      2026,
      7,
    );
    const configuredShifts = generateSchedule({
      year: 2026,
      month: 7,
      workHours: DEFAULT_WORK_HOURS,
      employees: [configured],
      holidayState: "BW",
    });

    expect(configured.targetMinutes).toBe(133 * 60);
    expect(configuredShifts.reduce((a, s) => a + s.paidMinutes, 0)).toBe(
      configured.targetMinutes,
    );
    for (const [, minutes] of perWeek(configuredShifts)) {
      expect(minutes).toBeLessThanOrEqual(30 * 60);
    }
  });
});

describe("kiểm tra lịch Azubi chỉnh tay", () => {
  const baseEmployee: Employee = {
    id: "AZ-VALIDATE",
    name: "Azubi Validate",
    employmentType: "AZUBI",
    targetMinutes: 0,
    azubi: {
      inSchoolTerm: true,
      schoolDays: ["monday", "tuesday"],
      weeklyHoursInTerm: 24,
      weeklyHoursOutOfTerm: 38.5,
    },
  };

  it("báo lỗi nếu có ca vào ngày học", () => {
    const shifts = [manualShift("school", "2026-09-07", 4 * 60)];
    const result = validateSchedule(
      [{ ...baseEmployee, targetMinutes: 4 * 60 }],
      shifts,
    );

    expect(result.errors.some((error) => error.message.includes("ngày đi học"))).toBe(true);
  });

  it("báo lỗi nếu vượt 24h hoặc quá 3 ngày làm trong một tuần", () => {
    const tooManyHours = [
      manualShift("hours-1", "2026-09-09", 8.5 * 60),
      manualShift("hours-2", "2026-09-10", 8.5 * 60),
      manualShift("hours-3", "2026-09-11", 8.5 * 60),
    ];
    const hoursResult = validateSchedule(
      [{ ...baseEmployee, targetMinutes: 25.5 * 60 }],
      tooManyHours,
    );
    expect(hoursResult.errors.some((error) => error.message.includes("vượt mức 24h"))).toBe(
      true,
    );

    const tooManyDays = [
      manualShift("days-1", "2026-09-09", 4 * 60),
      manualShift("days-2", "2026-09-10", 4 * 60),
      manualShift("days-3", "2026-09-11", 4 * 60),
      manualShift("days-4", "2026-09-12", 4 * 60),
    ];
    const daysResult = validateSchedule(
      [{ ...baseEmployee, targetMinutes: 16 * 60 }],
      tooManyDays,
    );
    expect(daysResult.errors.some((error) => error.message.includes("tối đa 3 ngày"))).toBe(
      true,
    );
  });
});

it("thứ tự đầu vào giữa Teilzeit và Azubi không làm lịch thay đổi", () => {
  const apprentice = azubi(40, true, ["monday", "tuesday"]);
  const partTime: Employee = {
    id: "TZ1",
    name: "Teilzeit",
    employmentType: "TEILZEIT",
    targetMinutes: 40 * 60,
  };
  const common = {
    year: 2026,
    month: 9,
    workHours: DEFAULT_WORK_HOURS,
    holidayState: "BW" as const,
    seed: "azubi-order",
  };

  expect(generateSchedule({ ...common, employees: [partTime, apprentice] })).toEqual(
    generateSchedule({ ...common, employees: [apprentice, partTime] }),
  );
});
