import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

function loadPureHelpers() {
  const t = readFileSync(new URL("../src/templates/list.html", import.meta.url), "utf8");
  const s = "// --- pure helpers (tested) ---", e = "// --- end pure helpers ---";
  const start = t.indexOf(s), end = t.indexOf(e);
  if (start === -1 || end === -1) throw new Error("Pure helpers marker range not found in list.html");
  const ctx = vm.createContext({ Date, Math, String, Number, Array, Object, console });
  vm.runInContext(t.slice(start + s.length, end), ctx);
  return ctx as any;
}

describe("list client pure helpers (buildRows)", () => {
  const now = new Date(2026, 9, 1, 12, 0, 0); // 1 out 2026

  it("finds marker range in list.html and exports buildRows, deriveKind and resolveFolderChip", () => {
    const h = loadPureHelpers();
    expect(typeof h.buildRows).toBe("function");
    expect(typeof h.deriveKind).toBe("function");
    expect(typeof h.resolveFolderChip).toBe("function");
  });

  describe("day grouping in all / root views", () => {
    it("formats day headers for today, yesterday, earlier this year, and earlier years", () => {
      const { buildRows } = loadPureHelpers();
      const t0 = Math.floor(new Date(2026, 9, 1, 10, 0, 0).getTime() / 1000);
      const t1 = Math.floor(new Date(2026, 8, 30, 15, 0, 0).getTime() / 1000);
      const t2 = Math.floor(new Date(2026, 8, 29, 9, 0, 0).getTime() / 1000);
      const t3 = Math.floor(new Date(2025, 8, 29, 9, 0, 0).getTime() / 1000);
      const files = [
        { id: "f1", filename: "today.png", created_at: t0 },
        { id: "f2", filename: "yesterday.pdf", created_at: t1 },
        { id: "f3", filename: "earlier.txt", created_at: t2 },
        { id: "f4", filename: "prevyear.doc", created_at: t3 },
      ];
      const rows = buildRows({ files, folders: [], view: "all", kind: "all", query: "", allLoaded: true, now });
      const dayRows = rows.filter((r: any) => r.type === "day");
      expect(dayRows.map((r: any) => r.label)).toEqual(["Hoje · 1 out", "Ontem · 30 set", "29 set", "29 set 2025"]);
    });

    it("formats summary as '1 pasta · 11 arquivos soltos' when 1 folder and 11 files in a day", () => {
      const { buildRows } = loadPureHelpers();
      const t0 = Math.floor(new Date(2026, 9, 1, 10, 0, 0).getTime() / 1000);
      const files = Array.from({ length: 11 }, (_, i) => ({ id: `f${i}`, filename: `file${i}.txt`, created_at: t0 - i * 60 }));
      const folders = [{ id: "dir1", name: "minha-pasta", updated_at: t0 }];
      const rows = buildRows({ files, folders, view: "all", kind: "all", query: "", allLoaded: true, now });
      const header = rows.find((r: any) => r.type === "day");
      expect(header?.label).toBe("Hoje · 1 out");
      expect(header?.summary).toBe("1 pasta · 11 arquivos soltos");
    });

    it("formats summary for folders only or files only", () => {
      const { buildRows } = loadPureHelpers();
      const t0 = Math.floor(new Date(2026, 9, 1, 10, 0, 0).getTime() / 1000);
      const folders = [{ id: "d1", name: "pasta1", updated_at: t0 }, { id: "d2", name: "pasta2", updated_at: t0 - 60 }];
      expect(buildRows({ files: [], folders, view: "all", kind: "all", query: "", allLoaded: true, now })[0].summary).toBe("2 pastas");
      const files = [{ id: "f1", filename: "single.txt", created_at: t0 }];
      expect(buildRows({ files, folders: [], view: "root", kind: "all", query: "", allLoaded: true, now })[0].summary).toBe("1 arquivo solto");
    });
  });

  describe("folder merging and filtering in all view", () => {
    it("merges folders only when updated_at >= oldest loaded file created_at if allLoaded is false", () => {
      const { buildRows } = loadPureHelpers();
      const files = [{ id: "f1", filename: "new.txt", created_at: 10000 }, { id: "f2", filename: "old.txt", created_at: 5000 }];
      const folders = [{ id: "d-recent", name: "recent", updated_at: 6000 }, { id: "d-older", name: "older", updated_at: 2000 }];
      const paged = buildRows({ files, folders, view: "all", kind: "all", query: "", allLoaded: false, now });
      expect(paged.filter((r: any) => r.type === "folder").map((r: any) => r.id)).toEqual(["d-recent"]);
      const all = buildRows({ files, folders, view: "all", kind: "all", query: "", allLoaded: true, now });
      expect(all.filter((r: any) => r.type === "folder").map((r: any) => r.id)).toEqual(["d-recent", "d-older"]);
    });

    it("hides folder rows when kind is not 'all'", () => {
      const { buildRows } = loadPureHelpers();
      const files = [{ id: "f1", filename: "photo.jpg", created_at: 10000, is_image: true }];
      const folders = [{ id: "d1", name: "folder1", updated_at: 10000 }];
      const rows = buildRows({ files, folders, view: "all", kind: "image", query: "", allLoaded: true, now });
      expect(rows.some((r: any) => r.type === "folder")).toBe(false);
      expect(rows.some((r: any) => r.type === "file")).toBe(true);
    });

    it("excludes folders in root view", () => {
      const { buildRows } = loadPureHelpers();
      const files = [{ id: "f1", filename: "root.txt", created_at: 10000 }];
      const folders = [{ id: "d1", name: "folder1", updated_at: 10000 }];
      const rows = buildRows({ files, folders, view: "root", kind: "all", query: "", allLoaded: true, now });
      expect(rows.some((r: any) => r.type === "folder")).toBe(false);
      expect(rows.some((r: any) => r.type === "file")).toBe(true);
    });
  });

  describe("search view", () => {
    it("places matching folders first before file rows, without day headers, and attaches folder chips to files", () => {
      const { buildRows } = loadPureHelpers();
      const files = [{ id: "f1", filename: "report-september.pdf", created_at: 10000, folder_id: "d1" }, { id: "f2", filename: "september-notes.txt", created_at: 9000 }];
      const folders = [{ id: "d1", name: "september-data", updated_at: 8000 }, { id: "d2", name: "other-stuff", updated_at: 12000 }];
      const rows = buildRows({ files, folders, view: "all", kind: "all", query: "september", allLoaded: true, now });
      expect(rows.some((r: any) => r.type === "day")).toBe(false);
      expect(rows.map((r: any) => `${r.type}:${r.name || r.filename}`)).toEqual(["folder:september-data", "file:report-september.pdf", "file:september-notes.txt"]);
      expect(rows.find((r: any) => r.id === "f1")?.folderChip).toBe("september-data");
      expect(rows.find((r: any) => r.id === "f2")?.folderChip).toBeFalsy();
    });
  });

  describe("other views (folder id, expiring)", () => {
    it("renders files directly with no day headers for expiring and folder views, adding folder chips only in expiring", () => {
      const { buildRows } = loadPureHelpers();
      const files = [{ id: "f1", filename: "a.txt", created_at: 10000, folder_id: "d1" }];
      const folders = [{ id: "d1", name: "d1", updated_at: 10000 }];
      const expRows = buildRows({ files, folders, view: "expiring", kind: "all", query: "", allLoaded: true, now });
      expect(expRows.some((r: any) => r.type === "day")).toBe(false);
      expect(expRows.find((r: any) => r.id === "f1")?.folderChip).toBe("d1");

      const folderRows = buildRows({ files, folders, view: "uuid-1234", kind: "all", query: "", allLoaded: true, now });
      expect(folderRows.some((r: any) => r.type === "day")).toBe(false);
      expect(folderRows.find((r: any) => r.id === "f1")?.folderChip).toBeFalsy();
    });
  });

  describe("deriveKind pure helper", () => {
    it("maps file types according to specification", () => {
      const { deriveKind } = loadPureHelpers();
      expect(deriveKind("photo.png", true)).toBe("image");
      expect(deriveKind("clip.mp4", false)).toBe("video");
      expect(deriveKind("clip.mov", false)).toBe("video");
      expect(deriveKind("clip.webm", false)).toBe("video");
      expect(deriveKind("doc.pdf", false)).toBe("document");
      expect(deriveKind("doc.docx", false)).toBe("document");
      expect(deriveKind("data.csv", false)).toBe("document");
      expect(deriveKind("notes.txt", false)).toBe("document");
      expect(deriveKind("script.json", false)).toBe("document");
      expect(deriveKind("archive.zip", false)).toBe("other");
      expect(deriveKind("app.exe", false)).toBe("other");
    });
  });

  describe("resolveFolderChip pure helper", () => {
    it("returns folder name in expiring view when file belongs to a folder", () => {
      const { resolveFolderChip } = loadPureHelpers();
      const folders = [{ id: "d1", name: "Projetos" }];
      expect(resolveFolderChip({ folder_id: "d1" }, folders, "expiring", "")).toBe("Projetos");
    });

    it("returns folder name in search view when file belongs to a folder", () => {
      const { resolveFolderChip } = loadPureHelpers();
      const folders = [{ id: "d1", name: "Projetos" }];
      expect(resolveFolderChip({ folder_id: "d1" }, folders, "all", "relatorio")).toBe("Projetos");
      expect(resolveFolderChip({ folder_id: "d1" }, folders, "root", "  relatorio  ")).toBe("Projetos");
    });

    it("returns null when file does not belong to a folder", () => {
      const { resolveFolderChip } = loadPureHelpers();
      const folders = [{ id: "d1", name: "Projetos" }];
      expect(resolveFolderChip({ folder_id: null }, folders, "expiring", "")).toBeNull();
      expect(resolveFolderChip({}, folders, "expiring", "")).toBeNull();
      expect(resolveFolderChip(null, folders, "expiring", "")).toBeNull();
      expect(resolveFolderChip({ folder_id: null }, folders, "all", "query")).toBeNull();
    });

    it("returns null in non-search, non-expiring views even if file has folder_id", () => {
      const { resolveFolderChip } = loadPureHelpers();
      const folders = [{ id: "d1", name: "Projetos" }];
      expect(resolveFolderChip({ folder_id: "d1" }, folders, "all", "")).toBeNull();
      expect(resolveFolderChip({ folder_id: "d1" }, folders, "root", "")).toBeNull();
      expect(resolveFolderChip({ folder_id: "d1" }, folders, "d1", "")).toBeNull();
    });

    it("falls back to file.folder_name if folder is missing from folders list", () => {
      const { resolveFolderChip } = loadPureHelpers();
      expect(resolveFolderChip({ folder_id: "d1", folder_name: "Fallback" }, [], "expiring", "")).toBe("Fallback");
      expect(resolveFolderChip({ folder_id: "d1" }, [], "expiring", "")).toBeNull();
    });
  });

  describe("row descriptors shape", () => {
    it("returns clean row descriptors without sub, folder, file, or [type] duplicates", () => {
      const { buildRows } = loadPureHelpers();
      const files = [{ id: "f1", filename: "test.txt", created_at: 10000, folder_id: "d1" }];
      const folders = [{ id: "d1", name: "pasta", updated_at: 10000 }];
      const rows = buildRows({ files, folders, view: "all", kind: "all", query: "", allLoaded: true, now });
      const day = rows.find((r: any) => r.type === "day");
      const folder = rows.find((r: any) => r.type === "folder");
      const file = rows.find((r: any) => r.type === "file");

      expect(day).toBeDefined();
      expect("sub" in day).toBe(false);

      expect(folder).toBeDefined();
      expect("folder" in folder).toBe(false);

      expect(file).toBeDefined();
      expect("file" in file).toBe(false);
    });

    it("returns clean row descriptors in search view without folder or file duplicates", () => {
      const { buildRows } = loadPureHelpers();
      const files = [{ id: "f1", filename: "searchme.txt", created_at: 10000 }];
      const folders = [{ id: "d1", name: "searchme-dir", updated_at: 10000 }];
      const rows = buildRows({ files, folders, view: "all", kind: "all", query: "searchme", allLoaded: true, now });
      const folder = rows.find((r: any) => r.type === "folder");
      const file = rows.find((r: any) => r.type === "file");

      expect(folder).toBeDefined();
      expect("folder" in folder).toBe(false);

      expect(file).toBeDefined();
      expect("file" in file).toBe(false);
    });
  });
});
