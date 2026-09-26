import { useEffect, useState } from "react";
import { useSchedule } from "./hooks/useSchedule";
import { SettingsTab } from "./components/SettingsTab";
import { EmployeesTab } from "./components/EmployeesTab";
import { ScheduleTab } from "./components/ScheduleTab";
import { StundenzettelTab } from "./components/StundenzettelTab";
import { DocsTab } from "./components/DocsTab";
import { Dashboard } from "./components/Dashboard";
import { LockScreen } from "./components/LockScreen";
import { CreateScheduleDialog } from "./components/CreateScheduleDialog";
import { isAuthenticated, logout } from "./lib/auth";
import { monthLabel } from "./lib/shiftOps";

type TabId = "dienstplan" | "mitarbeiter" | "stundenzettel" | "einstellungen";

// Häufig benutzt zuerst; Azubi steckt jetzt im Tab Nhân viên, Tài liệu oben rechts.
const TABS: { id: TabId; label: string }[] = [
  { id: "dienstplan", label: "Lịch làm việc" },
  { id: "mitarbeiter", label: "Nhân viên" },
  { id: "stundenzettel", label: "Bảng chấm công" },
  { id: "einstellungen", label: "Cài đặt" },
];

/** „Bản 26.09.2026 14:05 · 4e14b3f" – Zeit des Deploys in deutscher Ortszeit. */
function buildLabel(): string {
  const time = new Date(__BUILD_TIME__).toLocaleString("de-DE", {
    timeZone: "Europe/Berlin",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
  return `Bản ${time.replace(",", "")} · ${__BUILD_SHA__}`;
}

export default function App() {
  const [unlocked, setUnlocked] = useState(() => isAuthenticated());

  if (!unlocked) return <LockScreen onUnlock={() => setUnlocked(true)} />;
  return <MainApp onLogout={() => setUnlocked(false)} />;
}

function MainApp({ onLogout }: { onLogout: () => void }) {
  const store = useSchedule();
  const [tab, setTab] = useState<TabId>("dienstplan");
  const [showDocs, setShowDocs] = useState(false);
  const [askCreate, setAskCreate] = useState(false);
  // Nach dem Monatswechsel erst erzeugen, wenn der Zielmonat geladen ist.
  const [pendingCreate, setPendingCreate] = useState<{ year: number; month: number } | null>(null);

  const { schedule, generate, updateMeta } = store;
  useEffect(() => {
    if (!pendingCreate) return;
    if (schedule.year !== pendingCreate.year || schedule.month !== pendingCreate.month) return;
    setPendingCreate(null);
    generate();
  }, [pendingCreate, schedule.year, schedule.month, generate]);

  const createFor = (year: number, month: number) => {
    setAskCreate(false);
    setShowDocs(false);
    setTab("dienstplan");
    if (year !== schedule.year || month !== schedule.month) updateMeta({ year, month });
    setPendingCreate({ year, month });
  };

  return (
    <div className="min-h-screen">
      <header className="no-print bg-slate-900 text-white shadow sticky top-0 z-30">
        <div className="mx-auto max-w-[1500px] px-3 sm:px-4 py-3 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div>
            <h1 className="text-base sm:text-lg font-semibold">Lịch làm việc &amp; Bảng chấm công</h1>
            <p className="text-xs text-slate-300">
              {schedule.companyName || "Chưa có tên cửa hàng"} · {monthLabel(schedule.year, schedule.month)}
              {store.remoteStatus !== "off" && (
                <span
                  className={
                    store.remoteStatus === "error"
                      ? "ml-2 text-rose-300"
                      : "ml-2 text-slate-400"
                  }
                >
                  ·{" "}
                  {store.remoteStatus === "saving"
                    ? "đang đồng bộ…"
                    : store.remoteStatus === "error"
                      ? "lỗi đồng bộ — dữ liệu chỉ lưu trên máy này"
                      : "đã đồng bộ"}
                </span>
              )}
            </p>
            <p className="text-[11px] text-slate-400" title="Phiên bản đang chạy (ngày giờ deploy · mã commit)">
              {buildLabel()}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={() => setShowDocs((v) => !v)}
              className={`rounded px-3 py-2 text-sm ${
                showDocs ? "bg-white text-slate-900" : "bg-slate-700 hover:bg-slate-600"
              }`}
            >
              Tài liệu
            </button>
            <button
              onClick={() => {
                if (confirm("Xoá toàn bộ dữ liệu?")) store.resetAll();
              }}
              className="rounded bg-slate-700 px-3 py-2 text-sm hover:bg-slate-600"
            >
              Xoá dữ liệu
            </button>
            <button
              onClick={() => {
                logout();
                onLogout();
              }}
              className="rounded bg-slate-700 px-3 py-2 text-sm hover:bg-slate-600"
            >
              Đăng xuất
            </button>
          </div>
        </div>
      </header>

      {showDocs ? (
        <main className="no-print mx-auto max-w-[1500px] px-3 sm:px-4 py-4">
          <button
            onClick={() => setShowDocs(false)}
            className="mb-3 rounded border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50"
          >
            ← Quay lại
          </button>
          <DocsTab storeId={store.storeId} />
        </main>
      ) : (
        <>
          <div className="no-print mx-auto max-w-[1500px] px-3 sm:px-4 pt-4">
            <Dashboard store={store} />
          </div>

          <nav className="no-print mx-auto max-w-[1500px] px-3 sm:px-4 mt-4">
            <div className="flex flex-wrap items-center gap-2">
              <button
                onClick={() => setAskCreate(true)}
                className="rounded-full bg-emerald-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-emerald-700"
              >
                + Tạo lịch làm việc
              </button>
              <span className="mx-1 hidden sm:inline h-6 w-px bg-slate-200" />
              {TABS.map((t) => (
                <button
                  key={t.id}
                  onClick={() => setTab(t.id)}
                  className={`px-3.5 py-2 text-sm font-medium rounded-full border ${
                    tab === t.id
                      ? "bg-slate-900 text-white border-slate-900"
                      : "bg-white text-slate-600 border-slate-200 hover:text-slate-900 hover:border-slate-300"
                  }`}
                >
                  {t.label}
                </button>
              ))}
            </div>
          </nav>

          <main className="mx-auto max-w-[1500px] px-3 sm:px-4 py-4">
            <div className="no-print">
              {tab === "einstellungen" && <SettingsTab store={store} />}
              {tab === "mitarbeiter" && <EmployeesTab store={store} />}
              {tab === "dienstplan" && <ScheduleTab store={store} />}
            </div>
            {/* Bảng chấm công chứa vùng in – luôn render khi tab active */}
            {tab === "stundenzettel" && <StundenzettelTab store={store} />}
          </main>
        </>
      )}

      {askCreate && (
        <CreateScheduleDialog store={store} onClose={() => setAskCreate(false)} onCreate={createFor} />
      )}
    </div>
  );
}
