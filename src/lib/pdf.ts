// ============================================================================
// PDF-Export der Stundenzettel — VEKTOR statt Bild.
//
// Früher wurde jede Seite mit html2canvas als JPEG aufgenommen. Das war groß
// (Bilddaten) und auf manchen Geräten fehlerhaft (unscharfe/fehlende Linien,
// Serifen-Fallback wenn die Web-Schrift noch nicht geladen war). Jetzt wird die
// PDF direkt als echte Tabelle mit jsPDF + autoTable gezeichnet:
//   • gestochene Linien auf jedem Gerät (Vektor, kein Bild)
//   • winzige Dateigröße
//   • vietnamesische Namen korrekt — die Schrift (Roboto, Latin + Vietnamesisch)
//     ist eingebettet, unabhängig vom Font-Cache des Browsers
//   • keine Browser-Kopf-/Fusszeile (kein window.print => kein Datum, keine
//     .vercel.app-URL, keine Seitenzahl)
// ============================================================================

import { jsPDF } from "jspdf";
import autoTable from "jspdf-autotable";
import type { Employee, Schedule, Shift } from "../types";
import {
  datesOfMonth,
  parseIsoDate,
  WEEKDAY_LABELS_DE,
  weekdayKeyOf,
} from "./demand";
import { minutesToDecimalHours, minutesToTime } from "./time";
import { MONTH_NAMES_DE, signedHours } from "./dateFormat";
import { holidayNames as holidayNamesOf } from "./holidays";
import { azubiTimesheetMode, isAzubiSchoolTermDate } from "./azubi";
import { calculateZuschlaege } from "./zuschlaege";
import { format } from "date-fns";

// ---- Seitengeometrie (mm) --------------------------------------------------
const PAGE_W = 210;
const MARGIN = 14;
const CONTENT_W = PAGE_W - MARGIN * 2;

// ---- Farben (RGB) ----------------------------------------------------------
const INK: [number, number, number] = [15, 23, 42]; // slate-900
const MUTED: [number, number, number] = [100, 116, 139]; // slate-500
const RULE: [number, number, number] = [203, 213, 225]; // slate-300
const HEAD_FILL: [number, number, number] = [241, 245, 249]; // slate-100
const ZEBRA_FILL: [number, number, number] = [248, 250, 252]; // slate-50
const DARK_RULE: [number, number, number] = [30, 41, 59]; // slate-800

const FONT = "Roboto";

/** Dateiname säubern: Umlaute/Akzente weg, nur unbedenkliche Zeichen behalten. */
export function safeFileName(text: string): string {
  const plain = text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // Akzente entfernen: "Tuấn" -> "Tuan"
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D");
  return plain.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "") || "Stundenzettel";
}

// ---- Schrift einbetten (einmal pro Dokument, per Lazy-Import) ---------------
let fontCache: { regular: string; bold: string } | null = null;

async function loadFontData(): Promise<{ regular: string; bold: string }> {
  if (fontCache) return fontCache;
  const [reg, bold] = await Promise.all([
    import("./fonts/roboto-regular"),
    import("./fonts/roboto-bold"),
  ]);
  fontCache = { regular: reg.robotoRegularBase64, bold: bold.robotoBoldBase64 };
  return fontCache;
}

async function newDoc(): Promise<jsPDF> {
  const doc = new jsPDF({ unit: "mm", format: "a4", orientation: "portrait" });
  const data = await loadFontData();
  doc.addFileToVFS("Roboto-Regular.ttf", data.regular);
  doc.addFont("Roboto-Regular.ttf", FONT, "normal");
  doc.addFileToVFS("Roboto-Bold.ttf", data.bold);
  doc.addFont("Roboto-Bold.ttf", FONT, "bold");
  doc.setFont(FONT, "normal");
  return doc;
}

// ---- kleine Zeichen-Helfer -------------------------------------------------
function setColor(doc: jsPDF, c: [number, number, number]) {
  doc.setTextColor(c[0], c[1], c[2]);
}

/** Kopf: Titel links, Firma/Adresse darunter; rechts der Zeitraum. Gibt das
 *  Y unterhalb der Trennlinie zurück. */
function drawHeader(
  doc: jsPDF,
  y: number,
  opts: { title: string; company: string; address?: string; rightLines: string[] },
): number {
  doc.setFont(FONT, "bold");
  doc.setFontSize(16);
  setColor(doc, INK);
  doc.text(opts.title, MARGIN, y + 5);

  doc.setFont(FONT, "normal");
  doc.setFontSize(10);
  setColor(doc, MUTED);
  doc.text(opts.company || "—", MARGIN, y + 10.5);
  let leftBottom = y + 10.5;
  if (opts.address) {
    doc.setFontSize(8.5);
    doc.text(opts.address, MARGIN, y + 14.5);
    leftBottom = y + 14.5;
  }

  // Rechts ausgerichtet
  doc.setFontSize(10);
  let ry = y + 5;
  for (const line of opts.rightLines) {
    doc.text(line, PAGE_W - MARGIN, ry, { align: "right" });
    ry += 4.5;
  }

  const bottom = Math.max(leftBottom, ry) + 2;
  doc.setDrawColor(DARK_RULE[0], DARK_RULE[1], DARK_RULE[2]);
  doc.setLineWidth(0.5);
  doc.line(MARGIN, bottom, PAGE_W - MARGIN, bottom);
  return bottom + 5;
}

/** Zweispaltiges "Label: Wert"-Raster. Reihenfolge wie im On-Screen-Layout:
 *  links/rechts abwechselnd. Gibt das Y darunter zurück. */
function drawInfoGrid(doc: jsPDF, y: number, pairs: [string, string][]): number {
  const colW = CONTENT_W / 2;
  const lineH = 5;
  doc.setFontSize(9.5);
  // Wert-Spalte hinter das breiteste Label legen, damit lange Labels wie
  // "Beschäftigungsart" nicht in den Wert hineinlaufen.
  doc.setFont(FONT, "normal");
  const valueOffset =
    Math.max(24, ...pairs.map(([label]) => doc.getTextWidth(`${label}:`))) + 3;
  pairs.forEach((pair, i) => {
    const col = i % 2;
    const row = Math.floor(i / 2);
    const x = MARGIN + col * colW;
    const ly = y + row * lineH + 3.5;
    setColor(doc, MUTED);
    doc.setFont(FONT, "normal");
    doc.text(`${pair[0]}:`, x, ly);
    setColor(doc, INK);
    doc.setFont(FONT, "bold");
    doc.text(pair[1], x + valueOffset, ly);
  });
  const rows = Math.ceil(pairs.length / 2);
  return y + rows * lineH + 3;
}

/** Unterschriftszeilen am Seitenende. */
function drawSignatures(doc: jsPDF, y: number, labels: string[]) {
  const colW = CONTENT_W / labels.length;
  doc.setDrawColor(MUTED[0], MUTED[1], MUTED[2]);
  doc.setLineWidth(0.2);
  doc.setFont(FONT, "normal");
  doc.setFontSize(8.5);
  setColor(doc, MUTED);
  labels.forEach((label, i) => {
    const x = MARGIN + i * colW;
    doc.line(x, y, x + colW - 8, y);
    doc.text(label, x, y + 4);
  });
}

function employmentLabelDe(employee: Employee, year: number, month: number): string {
  if (employee.employmentType === "VOLLZEIT") return "Vollzeit";
  if (employee.employmentType === "TEILZEIT") return "Teilzeit";
  const mode = azubiTimesheetMode(employee.azubi, year, month);
  if (mode === "off") return "Ausbildung - kein Einsatz";
  if (mode === "work") return "Ausbildung - Arbeit";
  return "Ausbildung - Schule/Arbeit";
}

// ===========================================================================
// Stundenzettel (ein Mitarbeiter = eine Seite)
// ===========================================================================
function renderStundenzettelPage(
  doc: jsPDF,
  schedule: Schedule,
  employee: Employee,
  opts: { dates?: string[]; periodLabel?: string },
) {
  const rows = opts.dates ?? datesOfMonth(schedule.year, schedule.month);
  const byDate = new Map<string, Shift>();
  const employeeShifts = schedule.shifts.filter((s) => s.employeeId === employee.id);
  for (const s of employeeShifts) byDate.set(s.date, s);
  const shownShifts = employeeShifts.filter((s) => rows.includes(s.date));
  const totalMinutes = shownShifts.reduce((t, s) => t + s.paidMinutes, 0);
  const surcharges =
    employee.employmentType === "AZUBI"
      ? null
      : calculateZuschlaege(shownShifts, schedule.surchargeConfig);
  const diff = totalMinutes - employee.targetMinutes;
  const holidayNames = holidayNamesOf(schedule.year, schedule.holidayState);
  const closedByDate = new Map(
    schedule.dateOverrides.filter((o) => o.closed).map((o) => [o.date, o] as const),
  );
  const isWeek = Boolean(opts.dates);

  let y = drawHeader(doc, MARGIN, {
    title: "Stundenaufzeichnung",
    company: schedule.companyName || "—",
    address: schedule.address || undefined,
    rightLines: [opts.periodLabel ?? `${MONTH_NAMES_DE[schedule.month - 1]} ${schedule.year}`],
  });

  y = drawInfoGrid(doc, y, [
    ["Firmenname", schedule.companyName || "—"],
    ["Beschäftigungsart", employmentLabelDe(employee, schedule.year, schedule.month)],
    ["Mitarbeiter", employee.name],
    ["Monat", MONTH_NAMES_DE[schedule.month - 1]],
    ["Sollstunden", isWeek ? "—" : `${minutesToDecimalHours(employee.targetMinutes)} h`],
    ["Jahr", String(schedule.year)],
  ]);

  // Tabellenzeilen aufbauen
  const body = rows.map((d) => {
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
    if (s) bemerkung = holiday ? `Feiertag: ${holiday}` : "";
    else if (closed) bemerkung = closed.note || "Betriebsruhe";
    else if (holiday) bemerkung = `Frei (Feiertag: ${holiday})`;
    else if (isSchoolTermWeekday) bemerkung = "Berufsschule";
    else bemerkung = "Frei";

    const segs = s ? s.segments ?? [s] : [];
    const begins = segs.map((g) => minutesToTime(g.startMinutes)).join("\n");
    const ends = segs.map((g) => minutesToTime(g.endMinutes)).join("\n");
    const shaded = isWeekend || Boolean(holiday) || Boolean(closed);
    return {
      cells: [
        format(parseIsoDate(d), "dd.MM.yyyy"),
        wd,
        begins,
        ends,
        s && s.pauseMinutes > 0 ? `${s.pauseMinutes} Min` : "",
        s ? minutesToDecimalHours(s.paidMinutes) : "0,00",
        bemerkung,
      ],
      shaded,
    };
  });

  autoTable(doc, {
    startY: y,
    margin: { left: MARGIN, right: MARGIN },
    theme: "grid",
    styles: {
      font: FONT,
      fontSize: 7.5,
      cellPadding: { top: 0.8, bottom: 0.8, left: 1.5, right: 1.5 },
      lineColor: RULE,
      lineWidth: 0.1,
      textColor: INK,
      valign: "middle",
    },
    headStyles: {
      font: FONT,
      fontStyle: "bold",
      fillColor: HEAD_FILL,
      textColor: INK,
      halign: "center",
    },
    columnStyles: {
      0: { cellWidth: 22 },
      1: { cellWidth: 24 },
      2: { cellWidth: 24, halign: "center" },
      3: { cellWidth: 24, halign: "center" },
      4: { cellWidth: 20, halign: "center" },
      5: { cellWidth: 22, halign: "center" },
      6: { halign: "left", textColor: MUTED },
    },
    head: [["Datum", "Wochentag", "Arbeitsbeginn", "Arbeitsende", "Pause", "Arbeitszeit", "Bemerkung"]],
    body: body.map((r) => r.cells),
    foot: [["Gesamtstunden", "", "", "", "", minutesToDecimalHours(totalMinutes), ""]],
    footStyles: {
      font: FONT,
      fontStyle: "bold",
      fillColor: HEAD_FILL,
      textColor: INK,
      halign: "center",
    },
    didParseCell: (data) => {
      if (data.section === "body" && body[data.row.index]?.shaded) {
        data.cell.styles.fillColor = ZEBRA_FILL;
      }
      if (data.section === "foot") {
        // "Gesamtstunden" linksbündig über die ersten Spalten.
        if (data.column.index === 0) {
          data.cell.colSpan = 5;
          data.cell.styles.halign = "left";
        }
      }
    },
  });

  const table = (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable;
  let sy = table.finalY + 6;

  // Zusammenfassung: Gesamt / Soll / Differenz
  const third = CONTENT_W / 3;
  const summary: [string, string, [number, number, number]][] = [
    ["Gesamtstunden", `${minutesToDecimalHours(totalMinutes)} h`, INK],
    ["Sollstunden", isWeek ? "—" : `${minutesToDecimalHours(employee.targetMinutes)} h`, isWeek ? MUTED : INK],
    [
      "Differenz",
      isWeek ? "—" : `${signedHours(diff)} h`,
      isWeek ? MUTED : diff === 0 ? [4, 120, 87] : [190, 18, 60],
    ],
  ];
  summary.forEach(([label, value, color], i) => {
    const x = MARGIN + i * third;
    doc.setFont(FONT, "normal");
    doc.setFontSize(9);
    setColor(doc, MUTED);
    doc.text(label, x, sy);
    doc.setFont(FONT, "bold");
    doc.setFontSize(11);
    setColor(doc, color);
    doc.text(value, x, sy + 5);
  });
  sy += 10;

  // Zuschläge
  if (surcharges && (surcharges.after20Minutes > 0 || surcharges.sundayMinutes > 0)) {
    doc.setDrawColor(RULE[0], RULE[1], RULE[2]);
    doc.setLineWidth(0.2);
    doc.line(MARGIN, sy, PAGE_W - MARGIN, sy);
    sy += 4;
    doc.setFont(FONT, "bold");
    doc.setFontSize(8);
    setColor(doc, MUTED);
    doc.text("ZUSCHLÄGE", MARGIN, sy);
    sy += 5;
    const half = CONTENT_W / 2;
    // Nur die geleisteten Stunden je Kategorie – keine Prozent-/Bonuszeile.
    const blocks: [string, string][] = [
      ["Arbeitsstunden ab 20:00 Uhr", `${minutesToDecimalHours(surcharges.after20Minutes)} h`],
      ["Sonntagsstunden", `${minutesToDecimalHours(surcharges.sundayMinutes)} h`],
    ];
    blocks.forEach(([label, value], i) => {
      const x = MARGIN + i * half;
      doc.setFont(FONT, "normal");
      doc.setFontSize(9);
      setColor(doc, MUTED);
      doc.text(label, x, sy);
      doc.setFont(FONT, "bold");
      setColor(doc, INK);
      doc.text(value, x, sy + 4.5);
    });
    sy += 10;
  }

  // Unterschriften unten (mind. etwas Abstand, sonst am Seitenfuß)
  const sigY = Math.max(sy + 12, 272);
  drawSignatures(doc, sigY, ["Unterschrift Mitarbeiter", "Unterschrift Arbeitgeber", "Datum"]);
}

// ===========================================================================
// Öffentliche Export-Funktionen
// ===========================================================================

/** Baut das PDF-Dokument (ohne Download) – nützlich für Tests/Weiterverwendung. */
export async function buildStundenzettelDoc(params: {
  schedule: Schedule;
  employees: Employee[];
  dates?: string[];
  periodLabel?: string;
  onProgress?: (done: number, total: number) => void;
}): Promise<jsPDF> {
  const { schedule, employees, dates, periodLabel, onProgress } = params;
  const doc = await newDoc();
  for (let i = 0; i < employees.length; i++) {
    if (i > 0) doc.addPage();
    renderStundenzettelPage(doc, schedule, employees[i], { dates, periodLabel });
    onProgress?.(i + 1, employees.length);
    // dem Browser Luft geben, damit der Fortschritt sichtbar wird
    if (i < employees.length - 1) await new Promise((r) => setTimeout(r, 0));
  }
  return doc;
}

/** PDF für einen oder mehrere Mitarbeiter (je einer pro Seite). */
export async function exportStundenzettelPdf(params: {
  schedule: Schedule;
  employees: Employee[];
  filename: string;
  dates?: string[];
  periodLabel?: string;
  onProgress?: (done: number, total: number) => void;
}): Promise<void> {
  if (params.employees.length === 0) return;
  const doc = await buildStundenzettelDoc(params);
  downloadPdfBlob(doc.output("blob"), params.filename);
}

/** PDF immer als Datei herunterladen; Teilen bleibt eine separate Nutzeraktion. */
export function downloadPdfBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
