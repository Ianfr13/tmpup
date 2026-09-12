/** Content-type guessing (equivalent of Python's mimetypes.guess_type). */
import { lookup } from "mime-types";

/** Python's mimetypes._encodings_map (case sensitive, like CPython). */
const ENCODINGS_MAP: Record<string, string> = {
  ".gz": "gzip",
  ".Z": "compress",
  ".bz2": "bzip2",
  ".xz": "xz",
  ".br": "br",
  ".zst": "zstd",
};

/** Python's mimetypes._suffix_map. */
const SUFFIX_MAP: Record<string, string> = {
  ".tgz": ".tar.gz",
  ".taz": ".tar.gz",
  ".tz": ".tar.gz",
  ".tbz2": ".tar.bz2",
  ".tbz": ".tar.bz2",
  ".tb2": ".tar.bz2",
  ".tz2": ".tar.bz2",
  ".tlz": ".tar.lzma",
  ".txz": ".tar.xz",
  ".tzo": ".tar.zst",
};

/** posixpath.splitext: a leading dot is not an extension separator. */
function splitExt(value: string): [string, string] {
  const sepIndex = value.lastIndexOf("/");
  const dotIndex = value.lastIndexOf(".");
  if (dotIndex > sepIndex) {
    for (let i = sepIndex + 1; i < dotIndex; i += 1) {
      if (value[i] !== ".") {
        return [value.slice(0, dotIndex), value.slice(dotIndex)];
      }
    }
  }
  return [value, ""];
}

/**
 * Content type for a stored filename, mirroring
 * `mimetypes.guess_type(name)[0] or "application/octet-stream"`.
 *
 * The suffix/encoding unwrapping matters: Python resolves `x.tar.gz` and
 * `x.tgz` to `application/x-tar`, while a plain extension lookup answers
 * `application/gzip` / `application/octet-stream` and would change the
 * Content-Type header served by /d, /v and /t.
 */
export function guessContentType(filename: string): string {
  let [base, ext] = splitExt(filename);
  let expanded = SUFFIX_MAP[ext.toLowerCase()];
  while (expanded !== undefined) {
    [base, ext] = splitExt(base + expanded);
    expanded = SUFFIX_MAP[ext.toLowerCase()];
  }
  if (Object.prototype.hasOwnProperty.call(ENCODINGS_MAP, ext)) {
    [base, ext] = splitExt(base);
  }
  if (ext === "") {
    // Python's types_map has no entry for an empty extension (dotfiles,
    // extensionless names): mime-types would still read ".png" as a suffix.
    return "application/octet-stream";
  }
  const type = lookup(base + ext);
  return type === false ? "application/octet-stream" : type;
}
