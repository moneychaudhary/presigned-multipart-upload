/**
 * The failure shapes the default Classifier understands.
 *
 * It decides what is worth Retrying by reading `name` and `status` off whatever
 * was thrown, so those two fields are the contract. A custom Platform should
 * throw these from `sendPart`, and a custom Transport may throw `httpFailure`
 * from `signParts` so that a 503 is retried and a 403 refreshes, exactly as a
 * Part's own failures are. Defined once so the browser Platform, the JSON
 * Transport and the test fakes cannot drift apart on it.
 */

const named = (name: string, message: string, extra: object = {}): Error =>
  Object.assign(new Error(message), { name, ...extra });

/** The response arrived and was not 2xx. Carries `status`. */
export const httpFailure = (
  status: number,
  message = `The request failed with status ${status}`,
): Error => named("HttpError", message, { status });

/** No response ever arrived. */
export const networkFailure = (message = "The request never reached the network"): Error =>
  named("NetworkError", message);

/** The per-Attempt deadline passed. */
export const timeoutFailure = (timeoutMs: number): Error =>
  named("TimeoutError", `The request timed out after ${timeoutMs}ms`);

/** A Cancel or Pause reached the request. Ruled fatal: the Core asked for it. */
export const abortFailure = (message = "The request was aborted"): Error =>
  named("AbortError", message);
