import { describe, expect, it } from "vitest";
import type { Shift } from "../../types";
import { mealLabel, worksDinner, worksLunch } from "../shiftMeals";

const h = (x: number) => Math.round(x * 60);
const shift = (segs: [number, number][]): Shift => ({
  id: "s",
  employeeId: "e",
  date: "2026-08-03",
  startMinutes: h(segs[0][0]),
  endMinutes: h(segs[segs.length - 1][1]),
  pauseMinutes: 0,
  segments: segs.length > 1 ? segs.map(([a, b]) => ({ startMinutes: h(a), endMinutes: h(b) })) : undefined,
  paidMinutes: segs.reduce((sum, [a, b]) => sum + h(b) - h(a), 0),
  shiftType: "CUSTOM",
  generated: true,
});

describe("lunch / dinner presence", () => {
  it("counts anyone present in the evening, not only at 19:00", () => {
    expect(worksDinner(shift([[17.5, 20.5]]))).toBe(true);
    expect(worksDinner(shift([[19.5, 22]]))).toBe(true);
    expect(worksDinner(shift([[16.5, 18.5]]))).toBe(true);
    expect(worksLunch(shift([[16.5, 18.5]]))).toBe(false);
  });

  it("counts a split shift for both meals", () => {
    const s = shift([[11.5, 15], [17.5, 20]]);
    expect(worksLunch(s) && worksDinner(s)).toBe(true);
    expect(mealLabel(s)).toBe("Trưa + tối");
  });

  it("needs at least one hour in the meal to count", () => {
    const s = shift([[11.5, 17.5]]);
    expect(worksLunch(s)).toBe(true);
    expect(worksDinner(s)).toBe(false);
    expect(mealLabel(s)).toBe("Ca trưa");
  });
});
