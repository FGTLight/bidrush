/** Thrown by handlers for expected failures; rendered as `{ error: { code, message } }`. */
export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'HttpError'
  }
}
