import { format } from "date-fns";
import type { Employee, Schedule, Shift } from "../types";
import {
  parseIsoDate,
  WEEKDAY_LABELS_DE,
  weekdayKeyOf,
} from "../lib/demand";
import { holidayNames as holidayNamesOf } from "../lib/holidays";
import { minutesToDecimalHours, minutesToTime } from "../lib/time";

function employmentLabel(employee: Employee): string {
  if (employee.employmentType === "VOLLZEIT") return "Vollzeit";
  if (employee.employmentType === "TEILZEIT") return "Teilzeit";
  return "Ausbildung";
}

function roleLabel(employee: Employee): string {
  if (employee.workRole === "KITCHEN") return "Küche";
  if (employee.workRole === "SERVICE") return "Service";
  return "—";
}

function shiftLabel(shift: Shift): string {
  if (shift.segments?.length) return "Geteilter Dienst";
  if (shift.shiftType === "EARLY") return "Frühdienst";
  if (shift.shiftType === "LATE") return "Spätdienst";
  return "Individuell";
}

function shiftSegments(shift: Shift) {
  return shift.segments?.length
    ? shift.segments
    : [{ startMinutes: shift.startMinutes, endMinutes: shift.endMinutes }];
}

/** A4-Tagesübersicht für den Dienstplan; wird für Druck und PDF wiederverwendet. */
export function DailySchedulePage({ schedule, date }: { schedule: Schedule; date: string }) {
  const shifts = schedule.shifts.filter((shift) => shift.date === date);
  const shiftByEmployee = new Map(shifts.map((shift) => [shift.employeeId, shift] as const));
  const employeeById = new Map(schedule.employees.map((employee) => [employee.id, employee] as const));
  const dateValue = parseIsoDate(date);
  const weekday = WEEKDAY_LABELS_DE[weekdayKeyOf(dateValue)];
  const holiday = holidayNamesOf(schedule.year, schedule.holidayState).get(date);
  const override = schedule.dateOverrides.find((entry) => entry.date === date);

  const employees = [...schedule.employees].sort((left, right) => {
    const leftShift = shiftByEmployee.get(left.id);
    const rightShift = shiftByEmployee.get(right.id);
    if (Boolean(leftShift) !== Boolean(rightShift)) return leftShift ? -1 : 1;

    const roleOrder = { KITCHEN: 0, SERVICE: 1 } as const;
    const leftRole = left.workRole ? roleOrder[left.workRole] : 2;
    const rightRole = right.workRole ? roleOrder[right.workRole] : 2;
    if (leftRole !== rightRole) return leftRole - rightRole;

    if (leftShift && rightShift && leftShift.startMinutes !== rightShift.startMinutes) {
      return leftShift.startMinutes - rightShift.startMinutes;
    }
    return left.name.localeCompare(right.name, "de");
  });

  const totalMinutes = shifts.reduce((total, shift) => total + shift.paidMinutes, 0);
  const kitchenShifts = shifts.filter(
    (shift) => employeeById.get(shift.employeeId)?.workRole === "KITCHEN",
  );
  const serviceShifts = shifts.filter(
    (shift) => employeeById.get(shift.employeeId)?.workRole === "SERVICE",
  );
  const kitchenMinutes = kitchenShifts.reduce((total, shift) => total + shift.paidMinutes, 0);
  const serviceMinutes = serviceShifts.reduce((total, shift) => total + shift.paidMinutes, 0);

  return (
    <div className="daily-schedule-page mx-auto min-h-[297mm] max-w-[210mm] bg-white p-8 text-[12px] text-slate-900">
      <div className="mb-4 flex items-start justify-between border-b-2 border-slate-800 pb-3">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">Tagesdienstplan</h2>
          <p className="mt-1 font-medium text-slate-700">{schedule.companyName || "—"}</p>
          {schedule.address && <p className="text-[11px] text-slate-500">{schedule.address}</p>}
        </div>
        <div className="text-right">
          <div className="text-lg font-semibold">{weekday}</div>
          <div className="text-slate-600">{format(dateValue, "dd.MM.yyyy")}</div>
        </div>
      </div>

      {(holiday || override) && (
        <div className="mb-3 flex flex-wrap gap-2 text-[11px]">
          {holiday && <Badge>Feiertag: {holiday}</Badge>}
          {override?.closed && <Badge>Betrieb geschlossen</Badge>}
          {override && !override.closed && <Badge>Sonderöffnungszeit</Badge>}
          {override?.note && <Badge>{override.note}</Badge>}
        </div>
      )}

      <table className="w-full border-collapse text-[11px]">
        <thead>
          <tr className="bg-slate-100">
            <Th className="text-left">Mitarbeiter</Th>
            <Th>Bereich</Th>
            <Th>Beschäftigung</Th>
            <Th>Arbeitszeit</Th>
            <Th>Pause</Th>
            <Th>Stunden</Th>
            <Th>Status</Th>
          </tr>
        </thead>
        <tbody>
          {employees.map((employee) => {
            const shift = shiftByEmployee.get(employee.id);
            return (
              <tr key={employee.id} className={shift ? "" : "bg-slate-50 text-slate-500"}>
                <Td className="font-medium text-slate-900">{employee.name}</Td>
                <Td className="text-center">{roleLabel(employee)}</Td>
                <Td className="text-center">{employmentLabel(employee)}</Td>
                <Td className="text-center font-medium">
                  {shift
                    ? shiftSegments(shift).map((segment, index) => (
                        <div key={`${segment.startMinutes}-${segment.endMinutes}-${index}`}>
                          {minutesToTime(segment.startMinutes)}–{minutesToTime(segment.endMinutes)}
                        </div>
                      ))
                    : "—"}
                </Td>
                <Td className="text-center">
                  {shift && shift.pauseMinutes > 0 ? `${shift.pauseMinutes} Min` : "—"}
                </Td>
                <Td className="text-center">
                  {shift ? `${minutesToDecimalHours(shift.paidMinutes)} h` : "0,00 h"}
                </Td>
                <Td className="text-center">{shift ? shiftLabel(shift) : "Frei"}</Td>
              </tr>
            );
          })}
          {employees.length === 0 && (
            <tr>
              <Td className="py-6 text-center text-slate-500" colSpan={7}>
                Keine Mitarbeiter eingetragen.
              </Td>
            </tr>
          )}
        </tbody>
      </table>

      <div className="mt-4 grid grid-cols-4 gap-3">
        <Stat label="Im Einsatz" value={`${shifts.length} Pers.`} />
        <Stat label="Gesamtstunden" value={`${minutesToDecimalHours(totalMinutes)} h`} />
        <Stat
          label="Küche"
          value={`${kitchenShifts.length} Pers. · ${minutesToDecimalHours(kitchenMinutes)} h`}
        />
        <Stat
          label="Service"
          value={`${serviceShifts.length} Pers. · ${minutesToDecimalHours(serviceMinutes)} h`}
        />
      </div>

      <div className="mt-10 grid grid-cols-2 gap-12 text-[11px] text-slate-600">
        <div className="border-t border-slate-500 pt-1">Erstellt von / Datum</div>
        <div className="border-t border-slate-500 pt-1">Bestätigung</div>
      </div>
    </div>
  );
}

function Badge({ children }: { children: React.ReactNode }) {
  return <span className="rounded border border-slate-300 bg-slate-50 px-2 py-1">{children}</span>;
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded border border-slate-300 px-3 py-2">
      <div className="text-[10px] uppercase tracking-wide text-slate-500">{label}</div>
      <div className="mt-0.5 font-semibold text-slate-900">{value}</div>
    </div>
  );
}

function Th({ children, className = "" }: { children?: React.ReactNode; className?: string }) {
  return (
    <th className={`border border-slate-300 px-2 py-1.5 text-center font-semibold ${className}`}>
      {children}
    </th>
  );
}

function Td({
  children,
  className = "",
  colSpan,
}: {
  children?: React.ReactNode;
  className?: string;
  colSpan?: number;
}) {
  return (
    <td colSpan={colSpan} className={`border border-slate-300 px-2 py-1.5 ${className}`}>
      {children}
    </td>
  );
}
