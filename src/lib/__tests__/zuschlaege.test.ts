import { describe, expect, it } from "vitest";
import type { Shift } from "../../types";
import { shiftMinutesAfter20, zuschlagTotals } from "../zuschlaege";

function shift(patch: Partial<Shift>): Shift {
  return {
    id: "shift",
    employeeId: "employee",
    date: "2026-08-02",
    startMinutes: 16 * 60 + 30,
    endMinutes: 22 * 60,
    pauseMinutes: 0,
    paidMinutes: 5.5 * 60,
    shiftType: "LATE",
    generated: true,
    ...patch,
  };
}

describe("Zuschlaege", () => {
  it("counts the exact portion after 20:00 for continuous and split shifts", () => {
    expect(shiftMinutesAfter20(shift({}))).toBe(2 * 60);
    expect(
      shiftMinutesAfter20(
        shift({
          paidMinutes: 8 * 60,
          startMinutes: 10 * 60 + 30,
          segments: [
            { startMinutes: 10 * 60 + 30, endMinutes: 15 * 60 },
            { startMinutes: 16 * 60 + 30, endMinutes: 20 * 60 },
          ],
        }),
      ),
    ).toBe(0);
  });

  it("adds paid Sunday hours independently from hours after 20:00", () => {
    const sunday = shift({ date: "2026-08-02", paidMinutes: 5.5 * 60 });
    const monday = shift({ id: "monday", date: "2026-08-03", paidMinutes: 5.5 * 60 });

    expect(zuschlagTotals([sunday, monday])).toEqual({
      after20Minutes: 4 * 60,
      sundayMinutes: 5.5 * 60,
    });
  });
});
