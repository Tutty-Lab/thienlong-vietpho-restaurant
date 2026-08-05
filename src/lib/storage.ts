// ============================================================================
// Persistenz via LocalStorage. Speichert Firma, Mitarbeiter, Monat, den
// generierten Plan sowie den ursprünglich generierten Plan (für "Zurücksetzen").
// ============================================================================

import type { Schedule, Shift } from "../types";

// Je Filiale ein eigener Schlüssel – sonst würde das Umschalten die Daten
// der anderen Filiale überschreiben.
const keyFor = (storeId: string) => `stundenzettel-app:v1:${storeId}`;

export type PersistedState = {
  schedule: Schedule;
  /** Snapshot des zuletzt generierten Plans (für Reset). */
  originalShifts: Shift[];
};

export function loadState(storeId: string): PersistedState | null {
  try {
    const raw = localStorage.getItem(keyFor(storeId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PersistedState;
    if (!parsed?.schedule) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function saveState(storeId: string, state: PersistedState): void {
  try {
    localStorage.setItem(keyFor(storeId), JSON.stringify(state));
  } catch {
    // Speicher voll / nicht verfügbar – im MVP still ignorieren.
  }
}

export function clearState(storeId: string): void {
  try {
    localStorage.removeItem(keyFor(storeId));
  } catch {
    // ignorieren
  }
}
