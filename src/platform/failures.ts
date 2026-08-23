/**
 * The failure shapes a Platform must produce.
 *
 * The Classifier decides what is worth Retrying by reading `name` and `status`
 * off whatever a Platform threw, so those two fields are the contract between
 * them. Defined once here so the browser Platform and the test fake cannot
 * drift apart on it.
 */

const named = (name: string, message: string, extra: object = {}): Error =>
  Object.assign(new Error(message), { name, ...extra });

/** The response arrived and refused the Part. Carries `status`. */
export const httpFailure = (partNumber: number, status: number): Error =>
  named("HttpError", `Part ${partNumber} failed with status ${status}`, { status });

/** No response ever arrived. */
export const networkFailure = (partNumber: number): Error =>
  named("NetworkError", `Part ${partNumber} never reached the network`);

/** The per-Attempt deadline passed. */
export const timeoutFailure = (partNumber: number, timeoutMs: number): Error =>
  named("TimeoutError", `Part ${partNumber} timed out after ${timeoutMs}ms`);

/** A Cancel or Pause reached the request. Ruled fatal: the Core asked for it. */
export const abortFailure = (message: string): Error => named("AbortError", message);
