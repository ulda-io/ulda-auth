const messages = Object.freeze({
  INVALID_INPUT: "Invalid input.",
  INVALID_PACKET: "Invalid protocol packet.",
  UNSUPPORTED_PROFILE: "Unsupported resource profile.",
  CRYPTO_FAILED: "Cannot authenticate or decrypt resource.",
  CLOSED: "Client is closed.",
  OFFLINE: "Transport is not ready.",
  NOT_OPEN: "Open a master first.",
  UNKNOWN_OUTCOME:
    "The request may have committed. Automatic replay is disabled.",
  CONFLICT: "Resource changed. Refresh before applying the intention again.",
  NOT_FOUND: "Resource does not exist.",
  EXISTS: "Name already exists.",
  NEEDS_RESYNC: "Refresh is required before further writes.",
  ROLLBACK: "Older or inconsistent state rejected.",
  LIMIT: "Prototype limit exceeded.",
  UNSUPPORTED: "Operation requires an agreed protocol extension.",
  SERVER_ERROR: "Server rejected the request.",
  STALE_REFERENCE: "Reference belongs to an old context.",
  BUSY: "An operation is still running.",
  TIMEOUT: "Operation timed out.",
});
export class UldaError extends Error {
  constructor(code) {
    super(messages[code] ?? messages.SERVER_ERROR);
    this.name = "UldaError";
    this.code = code in messages ? code : "SERVER_ERROR";
  }
}
export const fail = (code) => {
  throw new UldaError(code);
};
export const check = (condition, code = "INVALID_INPUT") => {
  if (!condition) fail(code);
};
export const safeError = (error) =>
  error instanceof UldaError ? error : new UldaError("SERVER_ERROR");
