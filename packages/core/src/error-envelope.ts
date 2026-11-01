// AGPL-3.0-only; pinned commandErrorFromEnvelope adaptation. See NOTICE.
/** Pinned wire recognition. Invalid optional hints are independently absent;
 * code/message remain authoritative strings, reason is diagnostic only. */
export const recognizeError = (input: unknown) => {
  if (typeof input !== "object" || input === null || Array.isArray(input))
    return undefined;
  const error = input as Record<string, unknown>;
  if (typeof error.code !== "string" || typeof error.message !== "string")
    return undefined;
  const { reason, retryable, retry_after_ms, ...rest } = error;
  return {
    ...rest,
    code: error.code,
    message: error.message,
    ...(typeof reason === "string" && reason.length > 0 ? { reason } : {}),
    ...(typeof retryable === "boolean" ? { retryable } : {}),
    ...(typeof retry_after_ms === "number" &&
    Number.isFinite(retry_after_ms) &&
    retry_after_ms >= 0
      ? { retry_after_ms }
      : {}),
  };
};
