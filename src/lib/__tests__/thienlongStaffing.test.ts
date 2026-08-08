import { describe, expect, it } from "vitest";
import type { Employee } from "../../types";
import { weekdayKeyOf, parseIsoDate, datesOfMonth } from "../demand";
import { generateSchedule } from "../scheduler";
import { DEFAULT_WORK_HOURS } from "../workHours";

const currentThienlongEmployees: Employee[] = [
  { id: "service-fixed", name: "Service fixed", employmentType: "VOLLZEIT", targetMinutes: 192 * 60, workRole: "SERVICE", fixedStoreWeekPattern: true },
  { id: "kitchen-1", name: "Kitchen 1", employmentType: "VOLLZEIT", targetMinutes: 168 * 60, workRole: "KITCHEN" },
  { id: "kitchen-2", name: "Kitchen 2", employmentType: "VOLLZEIT", targetMinutes: 168 * 60, workRole: "KITCHEN" },
  { id: "service-1", name: "Service 1", employmentType: "TEILZEIT", targetMinutes: 100 * 60, workRole: "SERVICE" },
  { id: "kitchen-3", name: "Kitchen 3", employmentType: "VOLLZEIT", targetMinutes: 168 * 60, workRole: "KITCHEN" },
  { id: "kitchen-4", name: "Kitchen 4", employmentType: "VOLLZEIT", targetMinutes: 168 * 60, workRole: "KITCHEN" },
  { id: "service-2", name: "Service 2", employmentType: "TEILZEIT", targetMinutes: 20 * 60, workRole: "SERVICE" },
  { id: "service-3", name: "Service 3", employmentType: "TEILZEIT", targetMinutes: 60 * 60, workRole: "SERVICE" },
  { id: "azubi-1", name: "Azubi 1", employmentType: "AZUBI", targetMinutes: 174 * 60, workRole: "SERVICE" },
  { id: "azubi-2", name: "Azubi 2", employmentType: "AZUBI", targetMinutes: 174 * 60, workRole: "KITCHEN" },
  { id: "azubi-3", name: "Azubi 3", employmentType: "AZUBI", targetMinutes: 174 * 60, workRole: "SERVICE" },
  { id: "azubi-4", name: "Azubi 4", employmentType: "AZUBI", targetMinutes: 174 * 60, workRole: "KITCHEN" },
];

describe("Thienlong staffing bands", () => {
  it("keeps the current employee targets exact and limits busy days to eight people", () => {
    const employeeSnapshot = structuredClone(currentThienlongEmployees);
    const shifts = generateSchedule({
      year: 2026,
      month: 8,
      workHours: DEFAULT_WORK_HOURS,
      holidays: new Set<string>(),
      employees: currentThienlongEmployees,
      storeId: "thienlong",
      seed: "current-thienlong-staffing",
    });
    expect(currentThienlongEmployees).toEqual(employeeSnapshot);

    for (const employee of currentThienlongEmployees) {
      const minutes = shifts
        .filter((shift) => shift.employeeId === employee.id)
        .reduce((sum, shift) => sum + shift.paidMinutes, 0);
      expect(minutes, employee.id).toBe(employee.targetMinutes);
    }

    const stats = new Map<string, { people: Set<string>; minutes: number }>();
    for (const date of datesOfMonth(2026, 8)) stats.set(date, { people: new Set(), minutes: 0 });
    for (const shift of shifts) {
      const item = stats.get(shift.date)!;
      item.people.add(shift.employeeId);
      item.minutes += shift.paidMinutes;
    }

    const quietHours: number[] = [];
    const busyHours: number[] = [];
    for (const [date, item] of stats) {
      const weekday = weekdayKeyOf(parseIsoDate(date));
      if (["monday", "tuesday", "wednesday", "thursday"].includes(weekday)) {
        expect(item.people.size, date).toBeGreaterThanOrEqual(6);
        expect(item.people.size, date).toBeLessThanOrEqual(7);
        expect(item.minutes / 60, date).toBeGreaterThanOrEqual(52);
        expect(item.minutes / 60, date).toBeLessThanOrEqual(60);
        quietHours.push(item.minutes / 60);
      } else {
        expect(item.people.size, date).toBeLessThanOrEqual(8);
        busyHours.push(item.minutes / 60);
      }
    }

    const average = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
    expect(average(quietHours)).toBeGreaterThanOrEqual(55);
    expect(average(quietHours)).toBeLessThanOrEqual(60);
    expect(average(busyHours)).toBeGreaterThan(average(quietHours));
  });

  it.each([1, 12])("keeps the staffing caps in month %s", (month) => {
    const shifts = generateSchedule({
      year: 2026,
      month,
      workHours: DEFAULT_WORK_HOURS,
      holidays: new Set<string>(),
      employees: currentThienlongEmployees,
      storeId: "thienlong",
      seed: `current-thienlong-month-${month}`,
    });

    for (const employee of currentThienlongEmployees) {
      expect(
        shifts
          .filter((shift) => shift.employeeId === employee.id)
          .reduce((sum, shift) => sum + shift.paidMinutes, 0),
        employee.id,
      ).toBe(employee.targetMinutes);
    }

    for (const date of datesOfMonth(2026, month)) {
      const weekday = weekdayKeyOf(parseIsoDate(date));
      const people = new Set(
        shifts.filter((shift) => shift.date === date).map((shift) => shift.employeeId),
      );
      if (["monday", "tuesday", "wednesday", "thursday"].includes(weekday)) {
        expect(people.size, date).toBeGreaterThanOrEqual(6);
        expect(people.size, date).toBeLessThanOrEqual(7);
      } else {
        expect(people.size, date).toBeLessThanOrEqual(8);
      }
    }
  });
});
