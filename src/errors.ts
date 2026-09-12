/** HTTP error carrying a FastAPI-style `{"detail": ...}` payload. */
export class HttpError extends Error {
  readonly statusCode: number;
  readonly detail: string;

  constructor(statusCode: number, detail: string) {
    super(detail);
    this.name = "HttpError";
    this.statusCode = statusCode;
    this.detail = detail;
  }
}

export function badRequest(detail: string): HttpError {
  return new HttpError(400, detail);
}

export function notFound(detail = "File not found"): HttpError {
  return new HttpError(404, detail);
}

export function unauthorized(detail: string): HttpError {
  return new HttpError(401, detail);
}

export function forbidden(detail: string): HttpError {
  return new HttpError(403, detail);
}

export function serverError(detail: string): HttpError {
  return new HttpError(500, detail);
}
