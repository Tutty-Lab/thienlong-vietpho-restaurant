import type { Employee, Schedule, Shift } from "../types";
import {
  datesOfMonth,
  parseIsoDate,
  WEEKDAY_LABELS_DE,
  weekdayKeyOf,
} from "../lib/demand";
import { minutesToDecimalHours, minutesToTime } from "../lib/time";
import { signedHours } from "../lib/dateFormat";
import { MONTH_NAMES_DE } from "../lib/dateFormat";
import { holidayNames as holidayNamesOf } from "../lib/holidays";
import { azubiTimesheetMode, isAzubiSchoolTermDate } from "../lib/azubi";
import { calculateZuschlaege } from "../lib/zuschlaege";
import { format } from "date-fns";

// Deutscher Monats-Titel für das offizielle Dokument.
function monthLabelDe(year: number, month: number): string {
  return `${MONTH_NAMES_DE[month - 1]} ${year}`;
}

function employmentLabelDe(employee: Employee, year: number, month: number): string {
  if (employee.employmentType === "VOLLZEIT") return "Vollzeit";
  if (employee.employmentType === "TEILZEIT") return "Teilzeit";

  const mode = azubiTimesheetMode(employee.azubi, year, month);
  if (mode === "off") return "Ausbildung - kein Einsatz";
  if (mode === "work") return "Ausbildung - Arbeit";
  return "Ausbildung - Schule/Arbeit";
}

/**
 * Ein A4-freundlicher Stundenzettel für einen Mitarbeiter.
 * Wird sowohl für die Bildschirm-Vorschau als auch für den Druck verwendet.
 */
export function StundenzettelPage({
  schedule,
  employee,
  showThienlongExtras = false,
}: {
  schedule: Schedule;
  employee: Employee;
  showThienlongExtras?: boolean;
}) {
  const dates = datesOfMonth(schedule.year, schedule.month);
  const byDate = new Map<string, Shift>();
  const employeeShifts = schedule.shifts.filter((shift) => shift.employeeId === employee.id);
  for (const shift of employeeShifts) byDate.set(shift.date, shift);

  const totalMinutes = employeeShifts.reduce((total, shift) => total + shift.paidMinutes, 0);
  const surcharges = calculateZuschlaege(employeeShifts, schedule.surchargeConfig);
  const diff = totalMinutes - employee.targetMinutes;
  const holidayNames = holidayNamesOf(schedule.year, schedule.holidayState);
  const closedByDate = new Map(
    schedule.dateOverrides.filter((o) => o.closed).map((o) => [o.date, o] as const),
  );

  return (
    <div className="stundenzettel-page bg-white text-slate-900 mx-auto max-w-[210mm] p-6 text-[12px]">
      <div className="flex items-start justify-between border-b-2 border-slate-800 pb-2 mb-3">
        <div>
          <h2 className="text-xl font-bold tracking-tight">Stundenaufzeichnung</h2>
          <p className="text-slate-600">{schedule.companyName || "—"}</p>
          {schedule.address && <p className="text-slate-500 text-[11px]">{schedule.address}</p>}
        </div>
        <div className="text-right text-slate-600">
          <div>{monthLabelDe(schedule.year, schedule.month)}</div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-x-8 gap-y-1 mb-3">
        <Info label="Firmenname" value={schedule.companyName || "—"} />
        <Info
          label="Beschäftigungsart"
          value={employmentLabelDe(employee, schedule.year, schedule.month)}
        />
        <Info label="Mitarbeiter" value={employee.name} />
        <Info label="Monat" value={MONTH_NAMES_DE[schedule.month - 1]} />
        {showThienlongExtras && employee.workRole && (
          <Info
            label="Einsatzbereich"
            value={employee.workRole === "KITCHEN" ? "Küche" : "Service"}
          />
        )}
        <Info label="Sollstunden" value={`${minutesToDecimalHours(employee.targetMinutes)} h`} />
        <Info label="Jahr" value={String(schedule.year)} />
      </div>

      <table className="w-full border-collapse text-[11px]">
        <thead>
          <tr className="bg-slate-100">
            <Th>Datum</Th>
            <Th>Wochentag</Th>
            <Th>Arbeitsbeginn</Th>
            <Th>Arbeitsende</Th>
            <Th>Pause</Th>
            <Th>Arbeitszeit</Th>
            <Th className="text-left">Bemerkung</Th>
          </tr>
        </thead>
        <tbody>
          {dates.map((d) => {
            const s = byDate.get(d);
            const wd = WEEKDAY_LABELS_DE[weekdayKeyOf(parseIsoDate(d))];
            const holiday = holidayNames.get(d);
            const closed = closedByDate.get(d);
            const isWeekend = wd === "Samstag" || wd === "Sonntag";
            const isSchoolTermWeekday =
              employee.employmentType === "AZUBI" &&
              !isWeekend &&
              isAzubiSchoolTermDate(employee.azubi, d);
            let bemerkung: string;
            if (s) {
              bemerkung = holiday ? `Feiertag: ${holiday}` : "";
            } else if (closed) {
              bemerkung = closed.note || "Betriebsruhe";
            } else if (holiday) {
              bemerkung = `Frei (Feiertag: ${holiday})`;
            } else if (isSchoolTermWeekday) {
              bemerkung = "Berufsschule";
            } else {
              bemerkung = "Frei";
            }
            return (
              <tr key={d} className={isWeekend || holiday || closed ? "bg-slate-50" : ""}>
                <Td>{format(parseIsoDate(d), "dd.MM.yyyy")}</Td>
                <Td>{wd}</Td>
                {/* Geteilter Dienst: beide Stücke untereinander, so wie es auch
                    im handgeschriebenen Formular steht. */}
                <Td className="text-center">
                  {s
                    ? (s.segments ?? [s]).map((g, i) => (
                        <div key={i}>{minutesToTime(g.startMinutes)}</div>
                      ))
                    : ""}
                </Td>
                <Td className="text-center">
                  {s
                    ? (s.segments ?? [s]).map((g, i) => (
                        <div key={i}>{minutesToTime(g.endMinutes)}</div>
                      ))
                    : ""}
                </Td>
                <Td className="text-center">{s && s.pauseMinutes > 0 ? `${s.pauseMinutes} Min` : ""}</Td>
                <Td className="text-center">{s ? minutesToDecimalHours(s.paidMinutes) : "0,00"}</Td>
                <Td className="text-left text-slate-500">{bemerkung}</Td>
              </tr>
            );
          })}
        </tbody>
        <tfoot>
          <tr className="font-semibold bg-slate-100">
            <Td className="text-left" colSpan={5}>
              Gesamtstunden
            </Td>
            <Td className="text-center">{minutesToDecimalHours(totalMinutes)}</Td>
            <Td />
          </tr>
        </tfoot>
      </table>

      <div className="mt-3 grid grid-cols-3 gap-4 text-[12px]">
        <div>
          <div className="text-slate-500">Gesamtstunden</div>
          <div className="font-semibold">{minutesToDecimalHours(totalMinutes)} h</div>
        </div>
        <div>
          <div className="text-slate-500">Sollstunden</div>
          <div className="font-semibold">{minutesToDecimalHours(employee.targetMinutes)} h</div>
        </div>
        <div>
          <div className="text-slate-500">Differenz</div>
          <div className={`font-semibold ${diff === 0 ? "text-emerald-700" : "text-rose-700"}`}>
            {signedHours(diff)} h
          </div>
        </div>
      </div>

      <div className="mt-3 border-t border-slate-300 pt-2 text-[12px]">
        <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
          Zuschläge
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <div className="text-slate-500">Arbeitsstunden ab 20:00 Uhr</div>
            <div className="font-semibold">
              {minutesToDecimalHours(surcharges.after20Minutes)} h
            </div>
            <div className="text-[11px] text-slate-500">
              Zuschlag {surcharges.after20Percent.toLocaleString("de-DE")}%: +
              {minutesToDecimalHours(surcharges.after20BonusMinutes)} h
            </div>
          </div>
          <div>
            <div className="text-slate-500">Sonntagsstunden</div>
            <div className="font-semibold">
              {minutesToDecimalHours(surcharges.sundayMinutes)} h
            </div>
            <div className="text-[11px] text-slate-500">
              Zuschlag {surcharges.sundayPercent.toLocaleString("de-DE")}%: +
              {minutesToDecimalHours(surcharges.sundayBonusMinutes)} h
            </div>
          </div>
        </div>
        <div className="mt-2 flex items-center justify-between border-t border-slate-200 pt-2">
          <span className="text-slate-500">Zuschlagsstunden gesamt</span>
          <span className="font-semibold">
            +{minutesToDecimalHours(surcharges.totalBonusMinutes)} h
          </span>
        </div>
      </div>

      <div className="mt-10 grid grid-cols-3 gap-8 text-[11px]">
        <Signature label="Unterschrift Mitarbeiter" />
        <Signature label="Unterschrift Arbeitgeber" />
        <Signature label="Datum" />
      </div>
    </div>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-2">
      <span className="text-slate-500 min-w-[110px]">{label}:</span>
      <span className="font-medium">{value}</span>
    </div>
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

function Signature({ label }: { label: string }) {
  return (
    <div>
      <div className="border-t border-slate-500 pt-1 mt-8 text-slate-600">{label}</div>
    </div>
  );
}
