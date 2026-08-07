import type { Shift } from "../types";
import { minutesToTime } from "../lib/time";

export function ShiftTimes({ shift }: { shift: Shift }) {
  const segments = shift.segments?.length
    ? shift.segments
    : [{ startMinutes: shift.startMinutes, endMinutes: shift.endMinutes }];

  return (
    <div className="font-semibold leading-tight">
      {segments.map((segment, index) => (
        <div key={`${segment.startMinutes}-${segment.endMinutes}-${index}`}>
          {minutesToTime(segment.startMinutes)}–{minutesToTime(segment.endMinutes)}
        </div>
      ))}
    </div>
  );
}
