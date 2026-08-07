// ============================================================================
// Vordefinierte Schicht-Vorlagen. Für den Standard-Shop 10:00-22:00 werden die
// exakt in der Spezifikation genannten Vorlagen verwendet. Bei abweichenden
// Öffnungszeiten werden Vorlagen generisch abgeleitet (Früh am Öffnen verankert,
// Spät am Schließen verankert).
// ============================================================================

import { calculatePause, presenceFromPaid } from "./time";

export type TemplateType = "EARLY" | "LATE";

export type ShiftTemplate = {
  paidMinutes: number;
  pauseMinutes: number;
  startMinutes: number;
  endMinutes: number;
  type: TemplateType;
};

/** Erlaubte Schichtlängen in Stunden. */
export const SHIFT_LENGTHS = [4, 5, 6, 7, 8] as const;

const DEFAULT_OPEN = 10 * 60; // 10:00
const DEFAULT_CLOSE = 22 * 60; // 22:00

// Exakte Vorlagen laut Spezifikation für 10:00-22:00 (Zeiten in Minuten).
const SPEC_EARLY: Record<number, [number, number]> = {
  4: [12 * 60, 16 * 60], // 12:00-16:00
  5: [11 * 60, 16 * 60], // 11:00-16:00
  6: [10 * 60, 16 * 60], // 10:00-16:00
  7: [10 * 60, 17 * 60 + 30], // 10:00-17:30
  8: [10 * 60, 18 * 60 + 30], // 10:00-18:30
};
const SPEC_LATE: Record<number, [number, number]> = {
  4: [18 * 60, 22 * 60], // 18:00-22:00
  5: [17 * 60, 22 * 60], // 17:00-22:00
  6: [16 * 60, 22 * 60], // 16:00-22:00
  7: [14 * 60 + 30, 22 * 60], // 14:30-22:00
  8: [13 * 60 + 30, 22 * 60], // 13:30-22:00
};

function isDefaultHours(openMinutes: number, closeMinutes: number): boolean {
  return openMinutes === DEFAULT_OPEN && closeMinutes === DEFAULT_CLOSE;
}

/**
 * Liefert die Vorlage für eine bezahlte Stundenzahl und Früh/Spät.
 * @param paidHours 4..8
 */
export function getShiftTemplate(
  paidHours: number,
  type: TemplateType,
  openMinutes: number = DEFAULT_OPEN,
  closeMinutes: number = DEFAULT_CLOSE,
): ShiftTemplate {
  const paidMinutes = paidHours * 60;
  const pauseMinutes = calculatePause(paidMinutes);
  const presence = presenceFromPaid(paidMinutes);

  let startMinutes: number;
  let endMinutes: number;

  if (isDefaultHours(openMinutes, closeMinutes) && SPEC_EARLY[paidHours]) {
    const spec = type === "EARLY" ? SPEC_EARLY[paidHours] : SPEC_LATE[paidHours];
    [startMinutes, endMinutes] = spec;
  } else if (type === "EARLY") {
    startMinutes = openMinutes;
    endMinutes = openMinutes + presence;
  } else {
    endMinutes = closeMinutes;
    startMinutes = closeMinutes - presence;
  }

  return { paidMinutes, pauseMinutes, startMinutes, endMinutes, type };
}

/**
 * Wie oben, aber für einen Tag aus einem ODER zwei Blöcken:
 * Frühschicht liegt im ERSTEN Block, Spätschicht im LETZTEN. Dadurch fällt
 * nie eine Schicht in die Mittagsschließung (Mo–Do 15:00–16:30).
 */
export function getShiftTemplateForBlocks(
  paidHours: number,
  type: TemplateType,
  blocks: { startMinutes: number; endMinutes: number }[],
): ShiftTemplate {
  const presence = presenceFromPaid(paidHours * 60);
  const fits = (b: { startMinutes: number; endMinutes: number }) =>
    b.endMinutes - b.startMinutes >= presence;

  const first = blocks[0];
  const last = blocks[blocks.length - 1];

  // Wunschblock je nach Früh/Spät – aber nur, wenn die Schicht dort auch
  // wirklich hineinpasst. Sonst in den anderen Block ausweichen: der Mittags-
  // block ist kürzer als der Abendblock, eine 5-h-Schicht passt nur abends.
  // Ohne diese Prüfung liefe die Schicht über die Mittagsschließung hinweg.
  const preferred = type === "EARLY" ? first : last;
  const block = fits(preferred) ? preferred : fits(last) ? last : first;

  return getShiftTemplate(paidHours, type, block.startMinutes, block.endMinutes);
}

/** Bevorzugte Länge des Mittagsstücks bei geteiltem Dienst (aus den
 *  handgeschriebenen Plänen: fast immer 12:00–15:00). */
const PREFERRED_LUNCH_MINUTES = 3 * 60;

export type SplitPlan = {
  segments: { startMinutes: number; endMinutes: number }[];
  paidMinutes: number;
};

/**
 * Geteilter Dienst über beide Blöcke: ein Stück mittags, eines abends, dazwischen
 * ist der Laden zu. Keine gerechnete Pause – die Schließung IST die Ruhezeit.
 *
 * Aufteilung wie im handgeschriebenen Plan: mittags möglichst 3 h, der Rest
 * abends. Passt der Rest nicht in den Abendblock, wächst das Mittagsstück.
 * Beispiel 8 h: 12:00–15:00 + 16:30–21:30. Beispiel 9,5 h: 11:00–15:00 + 16:30–22:00.
 *
 * type = EARLY  -> Abendstück liegt am Anfang des Abendblocks
 * type = LATE   -> Abendstück liegt am Ende des Abendblocks (Ladenschluss)
 */
export function buildSplitShift(
  paidMinutes: number,
  type: TemplateType,
  blocks: { startMinutes: number; endMinutes: number }[],
): SplitPlan | null {
  if (blocks.length < 2) return null;
  const lunch = blocks[0];
  const evening = blocks[blocks.length - 1];
  const lunchCap = lunch.endMinutes - lunch.startMinutes;
  const eveningCap = evening.endMinutes - evening.startMinutes;

  if (paidMinutes > lunchCap + eveningCap) return null;

  // Mittags 3 h anstreben; reicht der Abend dann nicht, mittags aufstocken.
  let lunchPart = Math.min(PREFERRED_LUNCH_MINUTES, lunchCap, paidMinutes);
  if (paidMinutes - lunchPart > eveningCap) lunchPart = paidMinutes - eveningCap;
  const eveningPart = paidMinutes - lunchPart;

  // Beide Stücke müssen sinnvoll lang sein, sonst lieber durchgehend planen.
  if (lunchPart < 60 || eveningPart < 60) return null;
  if (lunchPart > lunchCap || eveningPart > eveningCap) return null;

  // An early split shift must actually open the restaurant. A late split shift
  // stays anchored at lunch closing, matching the handwritten schedules.
  const lunchSeg = type === "EARLY"
    ? {
        startMinutes: lunch.startMinutes,
        endMinutes: lunch.startMinutes + lunchPart,
      }
    : {
        startMinutes: lunch.endMinutes - lunchPart,
        endMinutes: lunch.endMinutes,
      };
  const eveningSeg =
    type === "EARLY"
      ? { startMinutes: evening.startMinutes, endMinutes: evening.startMinutes + eveningPart }
      : { startMinutes: evening.endMinutes - eveningPart, endMinutes: evening.endMinutes };

  return { segments: [lunchSeg, eveningSeg], paidMinutes };
}

/** Passt eine Schicht dieser Länge in mindestens einen Block des Tages? */
export function blockFor(
  paidMinutes: number,
  type: TemplateType,
  blocks: { startMinutes: number; endMinutes: number }[],
): { startMinutes: number; endMinutes: number } | null {
  const block = type === "EARLY" ? blocks[0] : blocks[blocks.length - 1];
  if (!block) return null;
  const presence = presenceFromPaid(paidMinutes);
  return block.endMinutes - block.startMinutes >= presence ? block : null;
}
