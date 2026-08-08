import { format } from "date-fns";
import type { Employee, Schedule, Shift } from "../types";
import {
  parseIsoDate,
  WEEKDAY_LABELS_DE,
  weekdayKeyOf,
} from "../lib/demand";
import { holidayNames as holidayNamesOf } from "../lib/holidays";
import { minutesToDecimalHours, minutesToTime } from "../lib/time";
import { calculateZuschlaege } from "../lib/zuschlaege";

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
  const surchargeRows = shifts
    .map((shift) => {
      const employee = employeeById.get(shift.employeeId);
      return employee
        ? { employee, calculation: calculateZuschlaege([shift], schedule.surchargeConfig) }
        : null;
    })
    .filter((row): row is NonNullable<typeof row> => row !== null)
    .filter(
      ({ calculation }) => calculation.after20Minutes > 0 || calculation.sundayMinutes > 0,
    );
  const dailySurcharges = calculateZuschlaege(shifts, schedule.surchargeConfig);
  const hasDailySurcharges =
    dailySurcharges.after20Minutes > 0 || dailySurcharges.sundayMinutes > 0;

  return (
    <div className="daily-schedule-page mx-auto min-h-[297mm] max-w-[210mm] bg-white p-6 text-[12px] text-slate-900">
      <div className="mb-3 flex items-start justify-between border-b-2 border-slate-800 pb-2">
        <div>
          <h2 className="text-xl font-bold tracking-tight">Tagesdienstplan</h2>
          <p className="text-slate-600">{schedule.companyName || "—"}</p>
          {schedule.address && <p className="text-[11px] text-slate-500">{schedule.address}</p>}
        </div>
        <div className="text-right text-slate-600">
          <div>{format(dateValue, "dd.MM.yyyy")}</div>
          <div>{weekday}</div>
        </div>
      </div>

      <div className="mb-3 grid grid-cols-2 gap-x-8 gap-y-1">
        <Info label="Firmenname" value={schedule.companyName || "—"} />
        <Info label="Datum" value={format(dateValue, "dd.MM.yyyy")} />
        <Info label="Adresse" value={schedule.address || "—"} />
        <Info label="Wochentag" value={weekday} />
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

      {hasDailySurcharges && (
        <section className="mt-3 break-inside-avoid">
          <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
            Zuschläge
          </div>
          <table className="w-full border-collapse text-[11px]">
            <thead>
              <tr className="bg-slate-100">
                <Th className="text-left">Mitarbeiter</Th>
                <Th>Ab 20:00</Th>
                <Th>Sonntag</Th>
                <Th>Gesamt</Th>
              </tr>
            </thead>
            <tbody>
              {surchargeRows.map(({ employee, calculation }) => (
                <tr key={employee.id}>
                  <Td className="font-medium">{employee.name}</Td>
                  <SurchargeCell
                    minutes={calculation.after20Minutes}
                    bonusMinutes={calculation.after20BonusMinutes}
                    percent={calculation.after20Percent}
                  />
                  <SurchargeCell
                    minutes={calculation.sundayMinutes}
                    bonusMinutes={calculation.sundayBonusMinutes}
                    percent={calculation.sundayPercent}
                  />
                  <Td className="text-center font-semibold">
                    +{minutesToDecimalHours(calculation.totalBonusMinutes)} h
                  </Td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="bg-slate-100 font-semibold">
                <Td>Gesamt</Td>
                <SurchargeCell
                  minutes={dailySurcharges.after20Minutes}
                  bonusMinutes={dailySurcharges.after20BonusMinutes}
                  percent={dailySurcharges.after20Percent}
                />
                <SurchargeCell
                  minutes={dailySurcharges.sundayMinutes}
                  bonusMinutes={dailySurcharges.sundayBonusMinutes}
                  percent={dailySurcharges.sundayPercent}
                />
                <Td className="text-center">
                  +{minutesToDecimalHours(dailySurcharges.totalBonusMinutes)} h
                </Td>
              </tr>
            </tfoot>
          </table>
        </section>
      )}

      <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-[12px] sm:grid-cols-4">
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

      <div className="mt-10 grid grid-cols-3 gap-8 text-[11px]">
        <div className="mt-8 border-t border-slate-500 pt-1 text-slate-600">Erstellt von</div>
        <div className="mt-8 border-t border-slate-500 pt-1 text-slate-600">Bestätigung</div>
        <div className="mt-8 border-t border-slate-500 pt-1 text-slate-600">Datum</div>
      </div>
    </div>
  );
}

function Badge({ children }: { children: React.ReactNode }) {
  return <span className="rounded border border-slate-300 bg-slate-50 px-2 py-1">{children}</span>;
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-slate-500">{label}</div>
      <div className="font-semibold">{value}</div>
    </div>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-2">
      <span className="min-w-[110px] text-slate-500">{label}:</span>
      <span className="font-medium">{value}</span>
    </div>
  );
}

function SurchargeCell({
  minutes,
  bonusMinutes,
  percent,
}: {
  minutes: number;
  bonusMinutes: number;
  percent: number;
}) {
  if (minutes <= 0) return <Td className="text-center text-slate-400">—</Td>;

  return (
    <Td className="text-center">
      <div>{minutesToDecimalHours(minutes)} h</div>
      <div className="text-[10px] text-slate-500">
        {percent.toLocaleString("de-DE")}%: +{minutesToDecimalHours(bonusMinutes)} h
      </div>
    </Td>
  );
}

function Th({ children, className = "" }: { children?: React.ReactNode; className?: string }) {
  return (
    <th className={`border border-slate-300 px-2 py-1 text-center font-semibold ${className}`}>
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
    <td colSpan={colSpan} className={`border border-slate-300 px-2 py-[3px] ${className}`}>
      {children}
    </td>
  );
}
