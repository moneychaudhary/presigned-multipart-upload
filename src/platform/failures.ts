/**
 * The failure shapes a Platform must produce.
 *
 * The Classifier decides what is worth Retrying by reading `name` and `status`
 * off whatever a Platform threw, so those two fields are the contract between
 * them. That contract used to live only inside the browser Platform, while the
 * test fake re-implemented it from memory — which meant the two could drift
 * apart and every Retry test would stay green while the library was broken in a
 * browser. Both go through here instead, so there is one definition and one
 * place to test it.
 */

const named = (name: string, message: string, extra: object = {}): Error =>
  Object.assign(new Error(message), { name, ...extra });

/** The response arrived and refused the Part. Carries `status` for the Classifier. */
export const httpFailure = (partNumber: number, status: number): Error =>
  named("HttpError", `Part ${partNumber} failed with status ${status}`, { status });

/** No response ever arrived — the connection failed outright. */
export const networkFailure = (partNumber: number): Error =>
  named("NetworkError", `Part ${partNumber} never reached the network`);

/** The per-Attempt deadline passed with the Part still in flight. */
export const timeoutFailure = (partNumber: number, timeoutMs: number): Error =>
  named("TimeoutError", `Part ${partNumber} timed out after ${timeoutMs}ms`);

/**
 * A Cancel or a Pause reached the request.
 *
 * `AbortError` is the name every browser uses and the Classifier rules fatal,
 * because the Core asked for this and must not Retry its own decision.
 */
export const abortFailure = (message: string): Error => named("AbortError", message);
