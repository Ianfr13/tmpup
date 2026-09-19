/**
 * Listing helpers: filter/sort/paginate.
 *
 * Ported 1:1 from app.py \`_filter_sort_paginate_files\` (1235-1281).
 */
import { config } from "./config.js";
import { fileKind, parseFileId } from "./storage.js";
import type { FileListPage, PublicFileMetadata } from "./types.js";

export interface FilterSortPaginateOptions {
  q?: string | null;
  kind?: string | null;
  sort?: string | null;
  page?: number | null;
  /** undefined = no folder filter; "root" = files without a folder; uuid = that folder. */
  folderId?: string | null;
}

function compare(a: number | string, b: number | string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/** Filter, sort and paginate a list of active file metadata dictionaries. */
export function filterSortPaginateFiles(
  allFiles: PublicFileMetadata[],
  opts: FilterSortPaginateOptions = {},
): FileListPage {
  let items = [...allFiles];

  const folderFilter = opts.folderId === undefined || opts.folderId === null ? null : String(opts.folderId).trim();
  if (folderFilter) {
    if (folderFilter.toLowerCase() === "root") {
      items = items.filter((f) => !f.folder_id);
    } else {
      let canonicalFolder = folderFilter;
      try {
        canonicalFolder = parseFileId(folderFilter);
      } catch {
        canonicalFolder = folderFilter;
      }
      items = items.filter((f) => f.folder_id === canonicalFolder);
    }
  }

  const targetKind = (opts.kind || "all").trim().toLowerCase();
  if (targetKind !== "all") {
    items = items.filter((f) => fileKind(f.filename ?? "") === targetKind);
  }

  if (opts.q) {
    const query = opts.q.trim().toLowerCase();
    if (query) {
      items = items.filter((f) => (f.filename ?? "").toLowerCase().includes(query));
    }
  }

  const sortKey = (opts.sort || "date").trim().toLowerCase();
  if (sortKey === "name") {
    items.sort((a, b) => compare((a.filename ?? "").toLowerCase(), (b.filename ?? "").toLowerCase()));
  } else if (sortKey === "size") {
    items.sort((a, b) => (b.size_bytes || 0) - (a.size_bytes || 0));
  } else if (sortKey === "expiry") {
    items.sort((a, b) => {
      const expiresA = a.expires_in ?? 0;
      const expiresB = b.expires_in ?? 0;
      const keyA = expiresA < 0 ? Number.POSITIVE_INFINITY : expiresA;
      const keyB = expiresB < 0 ? Number.POSITIVE_INFINITY : expiresB;
      return compare(keyA, keyB);
    });
  } else {
    items.sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
  }

  const pageSize = config.pageSize;
  const total = items.length;
  const totalPages = Math.ceil(total / pageSize);
  const totalSizeBytes = items.reduce((sum, f) => sum + (f.size_bytes || 0), 0);
  const expiringSoonCount = items.filter((f) => {
    const expiresIn = f.expires_in ?? -1;
    return expiresIn >= 0 && expiresIn < 3600;
  }).length;

  const page = Math.max(1, opts.page ?? 1);
  const start = (page - 1) * pageSize;

  return {
    items: items.slice(start, start + pageSize),
    total,
    page,
    page_size: pageSize,
    total_pages: totalPages,
    total_size_bytes: totalSizeBytes,
    expiring_soon_count: expiringSoonCount,
  };
}
