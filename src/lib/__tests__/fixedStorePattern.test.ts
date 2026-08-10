import { describe, expect, it } from "vitest";
import type { Employee } from "../../types";
import { weekdayKeyOf, parseIsoDate } from "../demand";
import { generateSchedule } from "../scheduler";
import { defaultWorkHoursForStore } from "../workHours";

function fixedEmployee(
  id: string,
  targetHours: number,
  employmentType: Employee["employmentType"],
  name = "Thuy Loan Pham Thi",
): Employee {
  return {
    id,
    name,
    employmentType,
    targetMinutes: targetHours * 60,
    fixedStoreWeekPattern: true,
  };
}

describe("fixed two-store week pattern", () => {
  it("uses Monday-Saturday for Thienlong and every Sunday for Vietpho", () => {
    const thienlongEmployee = fixedEmployee("loan-thienlong", 192, "VOLLZEIT");
    const vietphoEmployee = fixedEmployee("loan-vietpho", 20, "TEILZEIT");

    const thienlong = generateSchedule({
      year: 2026,
      month: 8,
      storeId: "thienlong",
      workHours: defaultWorkHoursForStore("thienlong"),
      holidays: new Set<string>(),
      employees: [thienlongEmployee],
      seed: "fixed-thienlong",
    });
    const vietpho = generateSchedule({
      year: 2026,
      month: 8,
      storeId: "vietpho",
      workHours: defaultWorkHoursForStore("vietpho"),
      holidays: new Set<string>(),
      employees: [vietphoEmployee],
      seed: "fixed-vietpho",
    });

    expect(thienlong).toHaveLength(26);
    expect(
      thienlong.every((shift) => weekdayKeyOf(parseIsoDate(shift.date)) !== "sunday"),
    ).toBe(true);
    expect(thienlong.reduce((sum, shift) => sum + shift.paidMinutes, 0)).toBe(192 * 60);

    const anotherSeed = generateSchedule({
      year: 2026,
      month: 8,
      storeId: "thienlong",
      workHours: defaultWorkHoursForStore("thienlong"),
      holidays: new Set<string>(),
      employees: [thienlongEmployee],
      seed: "a-different-seed",
    });
    expect(
      anotherSeed.map((shift) => [shift.date, shift.paidMinutes]),
    ).toEqual(thienlong.map((shift) => [shift.date, shift.paidMinutes]));

    expect(vietpho).toHaveLength(5);
    expect(
      vietpho.every((shift) => weekdayKeyOf(parseIsoDate(shift.date)) === "sunday"),
    ).toBe(true);
    expect(vietpho.map((shift) => shift.paidMinutes)).toEqual(Array(5).fill(4 * 60));
  });

  it("applies the two-store pattern to every checked employee, not one hard-coded name", () => {
    const thienlongEmployees = [
      fixedEmployee("loan-thienlong", 60, "VOLLZEIT", "Thuy Loan Pham Thi"),
      fixedEmployee("dao-thienlong", 60, "AZUBI", "Phung Quang Dao"),
    ];
    const vietphoEmployees = [
      fixedEmployee("loan-vietpho", 20, "TEILZEIT", "Thuy Loan Pham Thi"),
      fixedEmployee("dao-vietpho", 20, "TEILZEIT", "Phùng Quang Dạo"),
    ];

    const thienlong = generateSchedule({
      year: 2026,
      month: 8,
      storeId: "thienlong",
      workHours: defaultWorkHoursForStore("thienlong"),
      holidays: new Set<string>(),
      employees: thienlongEmployees,
      seed: "two-fixed-thienlong",
    });
    const vietpho = generateSchedule({
      year: 2026,
      month: 8,
      storeId: "vietpho",
      workHours: defaultWorkHoursForStore("vietpho"),
      holidays: new Set<string>(),
      employees: vietphoEmployees,
      seed: "two-fixed-vietpho",
    });

    for (const employee of thienlongEmployees) {
      expect(
        thienlong
          .filter((shift) => shift.employeeId === employee.id)
          .every((shift) => weekdayKeyOf(parseIsoDate(shift.date)) !== "sunday"),
      ).toBe(true);
    }
    for (const employee of vietphoEmployees) {
      expect(
        vietpho
          .filter((shift) => shift.employeeId === employee.id)
          .every((shift) => weekdayKeyOf(parseIsoDate(shift.date)) === "sunday"),
      ).toBe(true);
    }
  });
});
