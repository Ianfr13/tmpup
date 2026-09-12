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
