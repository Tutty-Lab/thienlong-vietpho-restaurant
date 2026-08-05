// ============================================================================
// Zentrales State-Management (ohne externe Bibliothek). Kapselt Schedule,
// LocalStorage-Persistenz und alle Aktionen (Generieren, Bearbeiten, Reset).
// ============================================================================

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Employee, EmploymentType, Schedule, Shift } from "../types";
import { generateSchedule } from "../lib/scheduler";
import { validateSchedule, type ValidationResult } from "../lib/validation";
import { clearState, loadState, saveState, type PersistedState } from "../lib/storage";
import { isRemoteConfigured, loadRemote, saveRemote, type RemoteStatus } from "../lib/remote";
import { createManualShift, updateShiftTimes } from "../lib/shiftOps";
import {
  DEFAULT_WORK_HOURS,
  normalizeWorkHours,
  type DateOverride,
  type OverrideMap,
} from "../lib/workHours";
import { COMPANY_ADDRESS, COMPANY_NAME } from "../lib/company";

function emptySchedule(): Schedule {
  const now = new Date();
  return {
    companyName: COMPANY_NAME,
    address: COMPANY_ADDRESS,
    year: now.getFullYear(),
    month: now.getMonth() + 1,
    workHours: structuredClone(DEFAULT_WORK_HOURS),
    dateOverrides: [],
    employees: [],
    shifts: [],
  };
}

/** Ausnahmen-Array -> nach Datum indizierte Map (für den Scheduler). */
function overridesToMap(list: DateOverride[]): OverrideMap {
  const map: OverrideMap = {};
  for (const ov of list) map[ov.date] = ov;
  return map;
}

/** Migriert einen (evtl. alten) gespeicherten Stand auf das aktuelle Schema. */
function normalizeSchedule(raw: Schedule | undefined): Schedule {
  const base = emptySchedule();
  if (!raw) return base;
  return {
    // Firmenname & Adresse sind fest (không cho sửa) – immer erzwingen.
    companyName: COMPANY_NAME,
    address: COMPANY_ADDRESS,
    year: raw.year ?? base.year,
    month: raw.month ?? base.month,
    workHours: normalizeWorkHours(raw.workHours),
    dateOverrides: Array.isArray(raw.dateOverrides) ? raw.dateOverrides : [],
    employees: raw.employees ?? [],
    shifts: raw.shifts ?? [],
  };
}

function newEmployeeId(): string {
  return `emp-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}

export function useSchedule() {
  const [schedule, setSchedule] = useState<Schedule>(() => {
    const persisted = loadState();
    return normalizeSchedule(persisted?.schedule);
  });
  const [originalShifts, setOriginalShifts] = useState<Shift[]>(() => {
    const persisted = loadState();
    return persisted?.originalShifts ?? [];
  });
  const [genError, setGenError] = useState<string | null>(null);
  const [remoteStatus, setRemoteStatus] = useState<RemoteStatus>(
    isRemoteConfigured ? "idle" : "off",
  );

  // Immer sofort lokal sichern – das ist der Offline-Puffer.
  useEffect(() => {
    saveState({ schedule, originalShifts });
  }, [schedule, originalShifts]);

  // Letzter Stand für Zugriffe außerhalb des Renders (siehe Erst-Upload).
  const latest = useRef<PersistedState>({ schedule, originalShifts });
  useEffect(() => {
    latest.current = { schedule, originalShifts };
  }, [schedule, originalShifts]);

  // Beim Start den Stand der Filiale aus der gemeinsamen Datenbank holen.
  // Vorher darf nicht hochgeladen werden, sonst überschreibt der lokale
  // (evtl. leere) Stand die Daten in der Datenbank.
  const hydrated = useRef(!isRemoteConfigured);
  useEffect(() => {
    if (!isRemoteConfigured) return;
    let cancelled = false;
    (async () => {
      try {
        const remote = await loadRemote();
        if (cancelled) return;
        if (remote?.schedule) {
          setSchedule(normalizeSchedule(remote.schedule));
          setOriginalShifts(remote.originalShifts ?? []);
        } else {
          // Noch keine Zeile für diese Filiale: lokalen Stand hochladen.
          await saveRemote(latest.current);
        }
        if (!cancelled) setRemoteStatus("idle");
      } catch {
        if (!cancelled) setRemoteStatus("error");
      } finally {
        if (!cancelled) hydrated.current = true;
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Änderungen gebündelt hochladen (nicht bei jedem Tastendruck).
  useEffect(() => {
    if (!isRemoteConfigured || !hydrated.current) return;
    const timer = window.setTimeout(() => {
      setRemoteStatus("saving");
      saveRemote({ schedule, originalShifts })
        .then(() => setRemoteStatus("idle"))
        .catch(() => setRemoteStatus("error"));
    }, 1000);
    return () => window.clearTimeout(timer);
  }, [schedule, originalShifts]);

  const validation: ValidationResult = useMemo(
    () => validateSchedule(schedule.employees, schedule.shifts),
    [schedule.employees, schedule.shifts],
  );

  // ----- Firma / Monat / Öffnungszeiten -----
  const updateMeta = useCallback((patch: Partial<Schedule>) => {
    setSchedule((s) => ({ ...s, ...patch }));
  }, []);

  // ----- Mitarbeiter -----
  const addEmployee = useCallback(
    (name: string, employmentType: EmploymentType, targetHours: number) => {
      const emp: Employee = {
        id: newEmployeeId(),
        name: name.trim() || "Neuer Mitarbeiter",
        employmentType,
        targetMinutes: Math.round(targetHours) * 60,
      };
      setSchedule((s) => ({ ...s, employees: [...s.employees, emp] }));
    },
    [],
  );

  const updateEmployee = useCallback((id: string, patch: Partial<Employee>) => {
    setSchedule((s) => ({
      ...s,
      employees: s.employees.map((e) => (e.id === id ? { ...e, ...patch } : e)),
    }));
  }, []);

  const removeEmployee = useCallback((id: string) => {
    setSchedule((s) => ({
      ...s,
      employees: s.employees.filter((e) => e.id !== id),
      shifts: s.shifts.filter((sh) => sh.employeeId !== id),
    }));
  }, []);

  // ----- Generierung -----
  const generate = useCallback(() => {
    setGenError(null);
    try {
      const shifts = generateSchedule({
        year: schedule.year,
        month: schedule.month,
        workHours: schedule.workHours,
        overrides: overridesToMap(schedule.dateOverrides),
        employees: schedule.employees,
      });
      setSchedule((s) => ({ ...s, shifts }));
      setOriginalShifts(shifts.map((sh) => ({ ...sh })));
    } catch (err) {
      setGenError(err instanceof Error ? err.message : String(err));
    }
  }, [
    schedule.year,
    schedule.month,
    schedule.workHours,
    schedule.dateOverrides,
    schedule.employees,
  ]);

  const resetToOriginal = useCallback(() => {
    setSchedule((s) => ({ ...s, shifts: originalShifts.map((sh) => ({ ...sh })) }));
  }, [originalShifts]);

  const resetAll = useCallback(() => {
    clearState();
    setSchedule(emptySchedule());
    setOriginalShifts([]);
    setGenError(null);
  }, []);

  const saveNow = useCallback(() => {
    saveState({ schedule, originalShifts });
  }, [schedule, originalShifts]);

  // ----- Ausnahmen je Datum -----
  const upsertOverride = useCallback((override: DateOverride) => {
    setSchedule((s) => {
      const rest = s.dateOverrides.filter((o) => o.date !== override.date);
      const next = [...rest, override].sort((a, b) => a.date.localeCompare(b.date));
      return { ...s, dateOverrides: next };
    });
  }, []);

  const removeOverride = useCallback((date: string) => {
    setSchedule((s) => ({
      ...s,
      dateOverrides: s.dateOverrides.filter((o) => o.date !== date),
    }));
  }, []);

  // ----- Schicht-Bearbeitung -----
  const findShift = useCallback(
    (employeeId: string, date: string): Shift | undefined =>
      schedule.shifts.find((s) => s.employeeId === employeeId && s.date === date),
    [schedule.shifts],
  );

  const editShiftTimes = useCallback(
    (
      shiftId: string,
      changes: Partial<Pick<Shift, "startMinutes" | "endMinutes" | "pauseMinutes">>,
    ) => {
      setSchedule((s) => ({
        ...s,
        shifts: s.shifts.map((sh) => (sh.id === shiftId ? updateShiftTimes(sh, changes) : sh)),
      }));
    },
    [],
  );

  const addShift = useCallback(
    (employeeId: string, date: string, start: number, end: number, pause: number) => {
      setSchedule((s) => {
        const exists = s.shifts.some((sh) => sh.employeeId === employeeId && sh.date === date);
        if (exists) return s;
        return { ...s, shifts: [...s.shifts, createManualShift(employeeId, date, start, end, pause)] };
      });
    },
    [],
  );

  const deleteShift = useCallback((shiftId: string) => {
    setSchedule((s) => ({ ...s, shifts: s.shifts.filter((sh) => sh.id !== shiftId) }));
  }, []);

  /** Markiert einen Tag als "Frei": entfernt eine bestehende Schicht. */
  const setFrei = useCallback((employeeId: string, date: string) => {
    setSchedule((s) => ({
      ...s,
      shifts: s.shifts.filter((sh) => !(sh.employeeId === employeeId && sh.date === date)),
    }));
  }, []);

  /** Verschiebt eine Schicht zu einem anderen Mitarbeiter (gleicher Tag). */
  const moveShiftToEmployee = useCallback((shiftId: string, targetEmployeeId: string) => {
    setSchedule((s) => {
      const shift = s.shifts.find((sh) => sh.id === shiftId);
      if (!shift) return s;
      const conflict = s.shifts.some(
        (sh) => sh.employeeId === targetEmployeeId && sh.date === shift.date,
      );
      if (conflict) return s;
      return {
        ...s,
        shifts: s.shifts.map((sh) =>
          sh.id === shiftId ? { ...sh, employeeId: targetEmployeeId, generated: false } : sh,
        ),
      };
    });
  }, []);

  return {
    schedule,
    originalShifts,
    validation,
    genError,
    hasOriginal: originalShifts.length > 0,
    updateMeta,
    addEmployee,
    updateEmployee,
    removeEmployee,
    generate,
    resetToOriginal,
    resetAll,
    remoteStatus,
    isRemoteConfigured,
    saveNow,
    upsertOverride,
    removeOverride,
    findShift,
    editShiftTimes,
    addShift,
    deleteShift,
    setFrei,
    moveShiftToEmployee,
  };
}

export type UseScheduleReturn = ReturnType<typeof useSchedule>;
