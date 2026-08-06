import { afterEach, describe, expect, it, vi } from "vitest";
import { downloadPdfBlob, safeFileName } from "../pdf";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("safeFileName", () => {
  it("entfernt vietnamesische Akzente", () => {
    expect(safeFileName("Nguyễn Văn Tuấn")).toBe("Nguyen_Van_Tuan");
    expect(safeFileName("Đức")).toBe("Duc");
  });

  it("entfernt deutsche Umlaute und ß-fremde Zeichen", () => {
    expect(safeFileName("Jörg Müller")).toBe("Jorg_Muller");
  });

  it("lässt unbedenkliche Zeichen stehen", () => {
    expect(safeFileName("Mai-2026_08")).toBe("Mai-2026_08");
  });

  it("hat immer einen brauchbaren Rückfallwert", () => {
    expect(safeFileName("   ")).toBe("Stundenzettel");
    expect(safeFileName("///")).toBe("Stundenzettel");
  });
});

describe("downloadPdfBlob", () => {
  it("downloads directly without opening the native share sheet", () => {
    vi.useFakeTimers();
    const anchor = { href: "", download: "", click: vi.fn() };
    const appendChild = vi.fn();
    const removeChild = vi.fn();
    const share = vi.fn();
    const createObjectURL = vi.fn(() => "blob:pdf");
    const revokeObjectURL = vi.fn();

    vi.stubGlobal("navigator", { canShare: () => true, share });
    vi.stubGlobal("URL", { createObjectURL, revokeObjectURL });
    vi.stubGlobal("document", {
      createElement: vi.fn(() => anchor),
      body: { appendChild, removeChild },
    });

    downloadPdfBlob(new Blob(["pdf"], { type: "application/pdf" }), "test.pdf");

    expect(share).not.toHaveBeenCalled();
    expect(anchor.href).toBe("blob:pdf");
    expect(anchor.download).toBe("test.pdf");
    expect(appendChild).toHaveBeenCalledWith(anchor);
    expect(anchor.click).toHaveBeenCalledOnce();
    expect(removeChild).toHaveBeenCalledWith(anchor);

    vi.runAllTimers();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:pdf");
  });
});
