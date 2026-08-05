import { describe, expect, it } from "vitest";
import { splitTargetHours } from "../splitTargetHours";

function sum(arr: number[]): number {
  return arr.reduce((a, b) => a + b, 0);
}

describe("splitTargetHours – Vollzeit", () => {
  it("summiert immer exakt auf das Ziel", () => {
    for (let h = 4; h <= 200; h++) {
      const parts = splitTargetHours(h, "VOLLZEIT");
      expect(sum(parts)).toBe(h);
      for (const p of parts) expect(p).toBeGreaterThanOrEqual(4);
      for (const p of parts) expect(p).toBeLessThanOrEqual(8);
    }
  });

  it("bevorzugt 8-h-Schichten (Beispiele aus der Spezifikation)", () => {
    expect(splitTargetHours(176, "VOLLZEIT")).toEqual(Array(22).fill(8));
    // 180 = 22×8 + 4
    expect(splitTargetHours(180, "VOLLZEIT").filter((x) => x === 8).length).toBe(22);
    expect(sum(splitTargetHours(180, "VOLLZEIT"))).toBe(180);
    // 179 = 21×8 + 7 + 4
    const s179 = splitTargetHours(179, "VOLLZEIT");
    expect(s179.filter((x) => x === 8).length).toBe(21);
    expect(sum(s179)).toBe(179);
    // 178 = 21×8 + 6 + 4
    const s178 = splitTargetHours(178, "VOLLZEIT");
    expect(s178.filter((x) => x === 8).length).toBe(21);
    expect(sum(s178)).toBe(178);
  });
});

describe("splitTargetHours – Teilzeit", () => {
  it("summiert exakt und vermeidet 7/8-h-Schichten wo möglich", () => {
    for (const h of [40, 55, 79, 80]) {
      const parts = splitTargetHours(h, "TEILZEIT");
      expect(sum(parts)).toBe(h);
      // keine 7/8-h-Schichten bei diesen Zielen
      expect(parts.every((p) => p <= 6)).toBe(true);
    }
  });

  it("55 = 11×5, 80 = 16×5, 79 = 11×5 + 4×6", () => {
    expect(splitTargetHours(55, "TEILZEIT")).toEqual(Array(11).fill(5));
    expect(splitTargetHours(80, "TEILZEIT")).toEqual(Array(16).fill(5));
    const s79 = splitTargetHours(79, "TEILZEIT").slice().sort((a, b) => a - b);
    expect(s79).toEqual([...Array(11).fill(5), ...Array(4).fill(6)].sort((a, b) => a - b));
  });
});

describe("splitTargetHours – Fehlerfälle", () => {
  it("wirft bei nicht darstellbaren Zielen", () => {
    expect(() => splitTargetHours(1, "VOLLZEIT")).toThrow();
    expect(() => splitTargetHours(3, "TEILZEIT")).toThrow();
  });
  it("0 => leere Liste", () => {
    expect(splitTargetHours(0, "VOLLZEIT")).toEqual([]);
  });
});
