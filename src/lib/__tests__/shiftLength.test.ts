import { describe, expect, it } from "vitest";
import { chooseShiftHours, maxShiftHoursForWindow } from "../scheduler";

describe("maxShiftHoursForWindow", () => {
  it("liefert die längste passende Schicht fürs Zeitfenster", () => {
    expect(maxShiftHoursForWindow(11 * 60)).toBe(8); // 11:00–22:00 (8h = 9h Anwesenheit)
    expect(maxShiftHoursForWindow(9 * 60)).toBe(8); // exakt 9 h Anwesenheit passt noch
    expect(maxShiftHoursForWindow(9 * 60 - 1)).toBe(7); // knapp zu kurz für die 8-h-Schicht
    expect(maxShiftHoursForWindow(5.5 * 60)).toBe(5); // halber Tag 11:00–16:30
    expect(maxShiftHoursForWindow(4.5 * 60)).toBe(4);
    expect(maxShiftHoursForWindow(3.5 * 60)).toBe(0); // zu kurz für 4 h
  });
});

describe("chooseShiftHours – Schicht passt sich dem Tag an", () => {
  it("Vollzeit arbeitet an einem halben Tag eine KÜRZERE Schicht (nicht frei)", () => {
    // 5,5 h Fenster => max 5 h. Rest bleibt exakt aufteilbar.
    const hours = chooseShiftHours(176 * 60, 5, "VOLLZEIT");
    expect(hours).toBeGreaterThanOrEqual(4);
    expect(hours).toBeLessThanOrEqual(5);
  });

  it("Vollzeit nimmt an normalen Tagen die 8-h-Schicht", () => {
    expect(chooseShiftHours(176 * 60, 8, "VOLLZEIT")).toBe(8);
  });

  it("hält den Rest exakt aufteilbar (nie Rest 1–3 h)", () => {
    // Rest von 11 h: 8 würde 3 h Rest lassen (ungültig) -> 7 wählen.
    expect(chooseShiftHours(11 * 60, 8, "VOLLZEIT")).toBe(7);
    // Rest von 8 h: 8 ist ok (Rest 0).
    expect(chooseShiftHours(8 * 60, 8, "VOLLZEIT")).toBe(8);
  });

  it("gibt 0 zurück, wenn keine gültige Länge möglich ist", () => {
    expect(chooseShiftHours(176 * 60, 3, "VOLLZEIT")).toBe(0); // Fenster < 4 h
    expect(chooseShiftHours(2 * 60, 8, "TEILZEIT")).toBe(0); // Rest zu klein
  });
});
