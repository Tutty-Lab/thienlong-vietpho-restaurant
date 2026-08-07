import { describe, expect, it } from "vitest";
import type { Employee } from "../../types";
import { checkScheduleReadiness } from "../readiness";

const employee = (patch: Partial<Employee> = {}): Employee => ({
  id: "employee-1",
  name: "Nguyen Van A",
  employmentType: "VOLLZEIT",
  targetMinutes: 160 * 60,
  saved: true,
  ...patch,
});

describe("Schedule readiness", () => {
  it("is green only when at least two complete employee records are confirmed", () => {
    const result = checkScheduleReadiness([
      employee(),
      employee({ id: "employee-2", name: "Tran Van B" }),
    ]);

    expect(result).toEqual({ ready: true, issues: [] });
  });

  it("explains incomplete configuration before schedule generation", () => {
    const result = checkScheduleReadiness([
      employee({ name: " ", saved: false, targetMinutes: 0 }),
    ]);

    expect(result.ready).toBe(false);
    expect(result.issues).toEqual([
      "Cần ít nhất 2 nhân viên.",
      "Mỗi nhân viên phải có tên.",
      "Hãy xác nhận lưu thông tin của tất cả nhân viên.",
      "Nhân viên thường phải có định mức lớn hơn 0 giờ.",
    ]);
  });

  it("accepts a confirmed Azubi with a zero-hour month", () => {
    const result = checkScheduleReadiness([
      employee(),
      employee({
        id: "azubi-1",
        name: "Azubi A",
        employmentType: "AZUBI",
        targetMinutes: 0,
      }),
    ]);

    expect(result.ready).toBe(true);
  });

  it("rejects a regular target that is shorter than the minimum shift", () => {
    const result = checkScheduleReadiness([
      employee({ targetMinutes: 2 * 60 }),
      employee({ id: "employee-2" }),
    ]);

    expect(result.ready).toBe(false);
    expect(result.issues).toContain("Nhân viên thường phải có định mức ít nhất 3 giờ.");
  });
});
