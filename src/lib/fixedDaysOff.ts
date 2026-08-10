import type { Employee, EmploymentType, WeekdayName } from "../types";
import { parseIsoDate, weekdayKeyOf } from "./demand";

export const WEEKDAY_ORDER: readonly WeekdayName[] = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
];

const WEEKDAYS = new Set<WeekdayName>(WEEKDAY_ORDER);

export function requiredFixedDaysOff(employmentType: EmploymentType): number {
  if (employmentType === "VOLLZEIT") return 1;
  if (employmentType === "AZUBI") return 2;
  return 0;
}

function fixedDaysForStore(employee: Employee, storeId?: string): WeekdayName[] {
  const source = Array.isArray(employee.fixedDaysOff) ? employee.fixedDaysOff : [];
  const valid = [...new Set(source)].filter(
    (weekday): weekday is WeekdayName => WEEKDAYS.has(weekday),
  );

  if (!employee.fixedStoreWeekPattern) return valid;
  if (storeId === "thienlong") {
    return ["sunday", ...valid.filter((weekday) => weekday !== "sunday")];
  }
  if (storeId === "vietpho") {
    // Sunday is the fixed working day at Vietpho for the two-store pattern.
    return valid.filter((weekday) => weekday !== "sunday");
  }
  return valid;
}

export function normalizedFixedDaysOff(employee: Employee, storeId?: string): Employee {
  const limit = requiredFixedDaysOff(employee.employmentType);
  if (limit === 0) {
    return employee.fixedDaysOff === undefined
      ? employee
      : { ...employee, fixedDaysOff: undefined };
  }

  const normalized = fixedDaysForStore(employee, storeId).slice(0, limit);
  const unchanged =
    Array.isArray(employee.fixedDaysOff) &&
    employee.fixedDaysOff.length === normalized.length &&
    employee.fixedDaysOff.every((weekday, index) => weekday === normalized[index]);

  return unchanged ? employee : { ...employee, fixedDaysOff: normalized };
}

export function hasRequiredFixedDaysOff(employee: Employee, storeId?: string): boolean {
  const required = requiredFixedDaysOff(employee.employmentType);
  if (required === 0) return true;
  return fixedDaysForStore(employee, storeId).length === required;
}

export function isEmployeeFixedDayOff(
  employee: Employee,
  isoDate: string,
  storeId?: string,
): boolean {
  const weekday = weekdayKeyOf(parseIsoDate(isoDate)) as WeekdayName;

  if (employee.fixedStoreWeekPattern && weekday === "sunday") {
    if (storeId === "thienlong") return true;
    if (storeId === "vietpho") return false;
  }
  return Array.isArray(employee.fixedDaysOff) && employee.fixedDaysOff.includes(weekday);
}
