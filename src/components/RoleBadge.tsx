import type { WorkRole } from "../types";

/** Nhãn Bếp/Bồi – giống danh sách nhân viên, để soát lịch theo nhóm. */
export function RoleBadge({ role }: { role?: WorkRole }) {
  if (!role) return null;
  return (
    <span
      className={`shrink-0 rounded text-[11px] font-medium px-1.5 py-0.5 ${
        role === "KITCHEN" ? "bg-orange-50 text-orange-700" : "bg-sky-50 text-sky-700"
      }`}
    >
      {role === "KITCHEN" ? "Bếp" : "Bồi"}
    </span>
  );
}
