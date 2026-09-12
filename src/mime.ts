/** Content-type guessing (equivalent of Python's mimetypes.guess_type). */
import { lookup } from "mime-types";

export function guessContentType(filename: string): string {
  const type = lookup(filename);
  return type === false ? "application/octet-stream" : type;
}
