import type { Employee } from "../types";

export type ScheduleReadiness = {
  ready: boolean;
  issues: string[];
};

export function checkScheduleReadiness(
  employees: Employee[],
  options: { requireAzubiWorkRole?: boolean } = {},
): ScheduleReadiness {
  const issues: string[] = [];

  if (employees.length < 2) issues.push("Cần ít nhất 2 nhân viên.");
  if (employees.some((employee) => employee.name.trim().length === 0)) {
    issues.push("Mỗi nhân viên phải có tên.");
  }
  if (employees.some((employee) => employee.saved !== true)) {
    issues.push("Hãy xác nhận lưu thông tin của tất cả nhân viên.");
  }
  if (
    employees.some(
      (employee) => employee.employmentType !== "AZUBI" && employee.targetMinutes <= 0,
    )
  ) {
    issues.push("Nhân viên thường phải có định mức lớn hơn 0 giờ.");
  }
  if (
    employees.some(
      (employee) =>
        employee.employmentType !== "AZUBI" &&
        employee.targetMinutes > 0 &&
        employee.targetMinutes < 3 * 60,
    )
  ) {
    issues.push("Nhân viên thường phải có định mức ít nhất 3 giờ.");
  }
  if (
    options.requireAzubiWorkRole &&
    employees.some(
      (employee) => employee.employmentType === "AZUBI" && !employee.workRole,
    )
  ) {
    issues.push("Hãy chọn vị trí Bếp hoặc Bồi cho tất cả Azubi.");
  }

  return { ready: issues.length === 0, issues };
}
