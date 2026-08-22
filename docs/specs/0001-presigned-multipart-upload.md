# Spec 0001 — presigned-multipart-upload

**Status:** ready-for-agent
**Vocabulary:** see `CONTEXT.md`. Capitalised terms below are glossary terms and are used
in their glossary sense throughout.

---

## Problem Statement

Uploading a large file from a browser to object storage is a solved problem only until
something goes wrong. In practice something always goes wrong: a laptop sleeps, a train
enters a tunnel, a corporate proxy resets a connection, a Presigned URL expires while a
4 GB file is still in flight, a user closes the tab at 90%.

Today every team rebuilds the same machinery to cope, badly. The reference implementation
this library is extracted from — a production VFX platform — is roughly 200 lines inlined
into a React component. It works, and it still cannot do any of the following:

- It has no retry at all. A single dropped Part fails the whole file.
- Its only recovery is to start the entire upload again from byte zero.
- The moment one Part errors it tears the whole Upload down at the provider, so the
  bytes that did land are discarded.
- Its Presigned URLs are minted once. An upload that outlives their expiry cannot finish,
  and reports a bare 403 when it dies.
- Nothing survives a page reload.
- It is welded to React, to `axios`, and to one application's API shape.

Developers reaching for an off-the-shelf answer find either heavyweight all-in-one widgets
that own the UI, or thin single-`PUT` helpers that do not do multipart at all. There is no
small, framework-neutral engine that does the hard part — surviving failure — and leaves
the UI alone.

## Solution

A framework-independent Core that drives a Batch of multipart Uploads against Presigned
URLs, and survives the failures above without the application having to think about them.

From the adopter's perspective:

- They supply a Transport: three functions hitting their own API to open, finalise and
  tear down an Upload. The library never holds storage credentials and never signs
  anything.
- They hand it files and get back an observable snapshot plus lifecycle events.
- Failure is handled beneath them. Parts that fail transiently are Retried automatically
  with backoff. Going offline parks the work rather than consuming Retries. An expired
  Presigned URL causes the Upload to be re-Opened for fresh URLs rather than dying.
- When retries genuinely run out, the Upload is left open at the provider and marked
  failed, so a single Resume call picks up from exactly the Parts that never landed.
- Uploads survive a page reload. Where the browser supports durable File Handles the
  bytes come back automatically; where it does not, the application asks the user to
  re-select the file and the library verifies it is the same one before continuing.
- The same engine is consumed from React, Angular or Vue through thin Adapters that
  add no behaviour of their own, and directly from anything else.

## User Stories

### Uploading

1. As an application developer, I want to hand the library a set of files and have them
   uploaded, so that I do not write chunking logic myself.
2. As an application developer, I want a single file to be accepted without batch
   ceremony, so that the common case stays simple even though Batch is the only model.
3. As an application developer, I want Parts sized sensibly by default, so that I do not
   have to learn the provider's minimum part size before my first upload.
4. As an application developer, I want the library to refuse a file it cannot legally
   split, so that I find out at once rather than on the ten-thousand-and-first Part.
5. As an end user, I want several files to upload at once, so that I do not wait for them
   one at a time.
6. As an application developer, I want a Connection Budget enforced across the whole
   Batch, so that many files do not silently exhaust the browser's per-host connection
   cap and stall.
7. As an application developer, I want each Upload's Parts sent concurrently up to that
   Budget, so that throughput is good on a fast connection.

### Observing

8. As an end user, I want to see overall progress for the Batch, so that I know how long
   is left.
9. As an end user, I want to see progress per file, so that I can tell which one is slow.
10. As an application developer, I want per-Part status and Attempt counts exposed, so
    that I can build a diagnostic view when something looks wrong.
11. As an application developer, I want one immutable snapshot I can subscribe to, so
    that rendering it is straightforward in any framework.
12. As an application developer, I want discrete lifecycle events in addition to state,
    so that I can fire a toast or an analytics ping exactly once per occurrence rather
    than diffing snapshots.
13. As an application developer, I want progress to be monotonic per Part within an
    Attempt and to reset visibly when a Part is Retried, so that my progress bar never
    goes backwards without explanation.

### Retry

14. As an end user, I want a momentary network blip to be invisible, so that my upload
    does not fail for a reason that fixed itself in two seconds.
15. As an application developer, I want Retries to back off exponentially, so that a
    struggling server is not hammered.
16. As an application developer, I want backoff to be jittered, so that many Parts that
    failed on the same dropped connection do not retry in lockstep and drop it again.
17. As an application developer, I want a bounded Retry budget per Part, so that a
    genuinely broken upload fails in finite time.
18. As an application developer, I want errors that cannot possibly succeed on a Retry to
    fail immediately, so that a malformed key does not take the full backoff ladder to
    report.
19. As an end user, I want an upload that goes offline to wait rather than fail, so that
    walking through a tunnel does not cost me my progress.
20. As an end user, I want the upload to pick itself back up when connectivity returns,
    so that I do not have to notice and intervene.
21. As an application developer, I want time spent offline not to consume the Retry
    budget, so that a laptop asleep for an hour does not exhaust every Part's attempts
    while disconnected.
22. As an application developer, I want an expired Presigned URL to cause the Upload to be
    re-Opened for fresh URLs rather than failing, so that long uploads survive their own
    URL expiry.
23. As an application developer, I want re-Opening to be tried once and then give up, so
    that a genuine authorisation failure does not become an infinite loop.
24. As an application developer, I want to replace the rule that decides what is
    retryable, so that an S3-compatible provider with unusual status codes does not force
    me to fork.

### Cancel and Pause

25. As an end user, I want to cancel an upload in progress, so that I can stop a file I
    picked by mistake.
26. As an end user, I want cancelling to stop immediately rather than after the current
    chunk finishes, so that it feels responsive on a slow connection.
27. As an application developer, I want Cancel to tear the Upload down at the provider,
    so that I am not billed for abandoned Parts I chose to discard.
28. As an application developer, I want Cancel to be terminal, so that there is no
    ambiguity about whether a cancelled Upload might come back.
29. As an end user, I want to cancel one file without cancelling the rest of the Batch,
    so that one mistake does not undo everything.
30. As an end user, I want to cancel the whole Batch at once, so that I can abandon
    everything with one action.
31. As an end user, I want to pause an upload, so that I can free my connection for
    something more urgent.
32. As an application developer, I want Pause to keep the Upload alive at the provider,
    so that resuming does not restart from zero.
33. As an end user, I want to resume a paused upload, so that I can continue when it
    suits me.
34. As an end user, I want to pause and resume the whole Batch, so that I can manage all
    my uploads together.

### Resume after failure

35. As an end user, I want a failed upload to offer a retry button, so that I can recover
    without re-picking my file.
36. As an end user, I want pressing that button to continue from where it stopped, so
    that I do not re-send gigabytes that already landed.
37. As an application developer, I want an Upload whose Retries are exhausted to be left
    open at the provider, so that Resume is possible at all.
38. As an application developer, I want the Parts that already landed to be preserved
    across a Resume, so that Resume is meaningfully cheaper than starting over.
39. As an application developer, I want Resume to obtain fresh Presigned URLs, so that it
    does not immediately fail against URLs that expired while the Upload sat failed.
40. As an application developer, I want to Resume one Upload or the whole Batch, so that
    I can offer either affordance.
41. As an application developer, I want Resume on an already-succeeded Upload to be a
    harmless no-op, so that a double-click cannot corrupt anything.
42. As an application developer, I want Resume on a cancelled Upload to be refused
    clearly, so that the terminal meaning of Cancel is enforced rather than assumed.

### Durable Resume

43. As an end user, I want an upload interrupted by closing the tab to be resumable when
    I come back, so that a multi-gigabyte transfer is not hostage to my browser session.
44. As an application developer, I want the Upload Record persisted automatically, so
    that I do not implement persistence myself.
45. As an application developer, I want to discover resumable Uploads on page load, so
    that I can offer the user the choice to continue them.
46. As an end user, I want the upload to continue without re-picking my file where my
    browser allows it, so that resuming is effortless.
47. As an end user, I want to be asked to re-select my file where my browser cannot
    remember it, so that resuming is still possible on Safari and Firefox.
48. As an application developer, I want the library to tell me which of those two paths
    applies, so that I show the right UI rather than guessing at browser support.
49. As an end user, I want to be told if I pick the wrong file when resuming, so that I
    do not silently corrupt my upload.
50. As an application developer, I want a Fingerprint mismatch to refuse the Resume with a
    distinct error, so that I can offer "start over" instead of failing opaquely.
51. As an application developer, I want a re-granted File Handle permission prompt to be
    handled, so that a denied prompt degrades to the re-selection path rather than
    throwing.
52. As an application developer, I want to substitute my own Record Store, so that I can
    scope records to the signed-in user and clear them on sign-out.
53. As a security-conscious application developer, I want one user's Records not to be
    resumable by the next user of a shared device, so that scoping is possible by design.
54. As an application developer, I want stale Records cleaned up, so that abandoned
    Uploads do not accumulate in browser storage forever.
55. As an application developer, I want a Record removed once its Upload succeeds or is
    Cancelled, so that finished work does not appear resumable.

### Configuration

56. As an application developer, I want the library to work with no configuration, so
    that my first integration is short.
57. As an application developer, I want to set Part size, so that I can tune for my
    users' typical file sizes and network.
58. As an application developer, I want to set the Connection Budget, so that I can tune
    against my own storage endpoint.
59. As an application developer, I want to set the Retry budget, backoff base, backoff
    ceiling and jitter, so that I can tune aggressiveness.
60. As an application developer, I want to set a per-Attempt timeout, so that a hung
    connection is detected rather than waited on forever.
61. As an application developer, I want to opt out of offline parking, so that I can fail
    fast if that suits my product.
62. As an application developer, I want to set the Content-Type sent with Parts, so that
    the stored object is served correctly.

### Integration

63. As a React developer, I want a hook, so that uploads integrate with my render cycle
    without glue code.
64. As an Angular developer, I want an injectable service exposing Signals, so that it
    fits a modern zoneless application.
65. As an Angular developer, I want an escape hatch to Observables, so that it fits an
    existing RxJS codebase.
66. As a Vue developer, I want reactive refs, so that it fits the composition API.
67. As a Svelte developer, I want the Core's own store to drive `$` auto-subscription,
    so that I need no adapter at all.
68. As a developer on no framework, I want the Core directly, so that I am not forced to
    adopt one.
69. As an application developer, I want importing the Core never to pull in a framework,
    so that my bundle stays small.
70. As an application developer, I want the library to add no runtime dependencies, so
    that it does not drag a tree into my lockfile.
71. As an application developer, I want full TypeScript types, so that the Transport
    contract is enforced at compile time.

### Backend and operations

72. As a backend developer, I want the Transport contract stated precisely, so that I know
    exactly what to implement.
73. As a backend developer, I want to know that Opening happens on two occasions and to be
    told which, so that I can return the existing Upload rather than creating a duplicate.
74. As a backend developer, I want to be told my bucket must expose the ETag header via
    CORS, so that I do not debug an opaque completion failure.
75. As an application developer, I want a missing ETag to fail immediately with a message
    naming the CORS fix, so that the most common setup mistake is self-diagnosing.
76. As an operator, I want to be told to set a lifecycle rule for abandoned Parts, so that
    leaving Uploads open on failure does not become an unbounded storage bill.
77. As an application developer, I want errors to be distinguishable by type, so that I
    can present the right message for each.

### Documentation

78. As a prospective adopter, I want a documentation site, so that I can evaluate the
    library before installing it.
79. As a prospective adopter, I want a complete working example including the backend
    side, so that I can see the whole picture rather than half of it.
80. As an adopter, I want a page per Adapter, so that I read only what applies to me.
81. As an adopter, I want a guide to Durable Resume, so that I understand the two paths
    and what my UI must provide.
82. As an adopter, I want the required bucket CORS and lifecycle configuration written
    out, so that I can set it up without reading provider documentation.
83. As an adopter, I want the retry and backoff behaviour documented, so that I can tune
    it rather than reverse-engineer it.

## Implementation Decisions

### Distribution

- Published as `presigned-multipart-upload`, verified available on npm.
- One package with subpath exports for the React, Angular and Vue Adapters. One
  version, one changelog, no possibility of pairing a Core with a mismatched Adapter.
- Zero runtime dependencies. Frameworks are optional peer dependencies, so importing the
  Core pulls in nothing.
- MIT licensed.
- Angular's Adapter exposes Signals with an Observable interop function, covering both
  modern and RxJS-era codebases from a single implementation.

### Boundary

- The library consumes Presigned URLs and never signs anything. No storage SDK is a
  dependency and no credentials reach the browser.
- Only sending a Part's bytes goes to a Presigned URL. Opening, finalising and tearing
  down are Transport functions the application implements against its own API.
- Opening is a single function serving both occasions, told explicitly which occasion it
  is, rather than a separate URL-refresh function. Both occasions return a usable set of
  Presigned URLs, because URLs minted earlier may no longer be honoured.

The Transport contract, from the design prototype, as the precise statement of what an
adopter implements:

```ts
interface Transport {
  open(file: FileDescriptor, ctx: {
    partCount: number
    partSize: number
    resumeFrom?: { key: string; uploadId: string }   // present iff taking up an existing Upload
    signal: AbortSignal
  }): Promise<{ key: string; uploadId: string; urls: string[] }>

  complete(args: { key: string; uploadId: string; parts: { partNumber: number; eTag: string }[] }): Promise<unknown>

  abort(args: { key: string; uploadId: string }): Promise<unknown>
}
```

### Model

- Batch is the only unit of work; a single file is a Batch of one. There is no separate
  single-file controller. The single-file path must remain free of batch boilerplate.
- The Connection Budget is enforced across the whole Batch, not per Upload, because the
  browser's cap is per host. Each Upload receives a share that shrinks as more Uploads
  become active. The allocation rule is exported so adopters can reason about it.
- The five verbs — Attempt, Retry, Resume, Cancel, Pause — are distinct and are never
  conflated in API names, states, events or documentation.

### Lifecycle

- Upload states: pending, opening, uploading, paused, completing, succeeded, failed,
  cancelled.
- Exhausting a Part's Retry budget moves the Upload to failed and deliberately does **not**
  tear it down at the provider. This is what makes Resume possible; the cost is orphaned
  Parts, which the documentation addresses with a required lifecycle rule.
- Cancel is terminal and does tear down at the provider. Resume on a cancelled Upload is
  refused with a distinct error.
- Pause stops scheduling and aborts in-flight Attempts but leaves the Upload open.
- Resume re-Opens the Upload for fresh URLs, then drives only the Parts that have not
  landed. Resume on a succeeded Upload is a no-op.
- Batch-level Cancel, Pause and Resume fan out to member Uploads; per-Upload actions do
  not affect siblings.

### Retry

- Default classification: connection failure and timeout Retry; 429 and 5xx Retry; 403 and
  401 trigger one re-Open then are fatal; other 4xx are fatal; an unreadable ETag is fatal
  immediately with a message naming the CORS `ExposeHeaders` fix.
- Backoff is exponential with full jitter — random across the whole window rather than
  base plus random — so that Parts failing together do not retry together.
- Offline is parked on rather than Retried through. Time offline does not consume the
  Retry budget. Work wakes on connectivity returning.
- The classifier is replaceable by the adopter.

### Durability

- The Upload Record — object key, provider Upload identifier, landed Parts and their
  ETags, and the file descriptor — is persisted continuously as Parts land.
- Durable Resume requires both halves: the Record and access to the bytes. Where the
  browser provides a durable File Handle it is stored and re-opened, including handling a
  denied permission re-prompt. Where it does not, the application is told a re-selection
  is required and supplies the file.
- Both paths ship. Neither is optional, because the handle path does not cover Safari or
  Firefox.
- Fingerprint is name, size and last-modified time. It is checked before any Part is sent
  on a Resume. A mismatch refuses the Resume with a distinct error and never mixes Parts
  from two files into one object.
- The Record Store defaults to the browser's structured-storage mechanism, which is the
  only one able to hold a File Handle, and is swappable so Records can be scoped per user.
- Records are removed on success and on Cancel, and stale Records are expired.

### Observation

- The Core holds one immutable snapshot covering Batch status and aggregate progress,
  per-Upload status and progress, and per-Part status, Attempt count and progress. Changes
  notify subscribers.
- Discrete lifecycle events are emitted separately for things that are moments rather than
  states, so consumers need not diff snapshots to notice them once.
- Adapters wrap exactly this and add no behaviour. Any decision an Adapter appears to need
  belongs in the Core.

### Configuration

- Works with no configuration. Part size, Connection Budget, Retry budget, backoff base,
  backoff ceiling, jitter, per-Attempt timeout, offline behaviour, Fingerprint strictness
  and Content-Type are all overridable values.
- The retry classifier is overridable as a function.

### Platform seam

The Core reaches the outside world through exactly one injected object, so that all
behaviour above it is pure and testable through the public API:

```ts
interface Platform {
  sendPart(args: { url, body, contentType, timeoutMs, signal, onProgress }): Promise<{ eTag: string }>
  now(): number
  sleep(ms: number, signal?: AbortSignal): Promise<void>
  random(): number
  isOnline(): boolean
  onOnline(cb: () => void): () => void
  files: { isHandleSupported(): boolean; getHandle(id): Promise<Handle|null>; requestPermission(h): Promise<boolean> }
}
```

Part bytes are sent with `XMLHttpRequest` in the browser Platform, because upload progress
is not observable through `fetch`, and because an individual request must be abortable for
Cancel and Pause to be immediate.

## Testing Decisions

### What makes a good test here

Tests drive the public entry point and assert on the snapshot and the emitted events.
They never reach into internal state, never assert on private structures, and never assert
that a particular internal function was called. A test should read as a statement about
behaviour an adopter could observe: "when part 3 fails twice and then succeeds, the Upload
succeeds and part 3 records three Attempts".

Determinism is mandatory. No test waits on real time, real randomness, or a real network.

### Seams used

One new seam — the `Platform` — plus two that are already public configuration and are
therefore exercised through the same door adopters use: the `Transport` and the
`Record Store`. Tests supply a scripted `Platform`, a fake `Transport` and an in-memory
`Record Store`; nothing else is substituted.

There is no prior art for tests in this repository — it is new, and the implementation this
work is extracted from had none. These fakes establish the pattern.

### Cases to cover

**Part planning**
- File smaller than one Part yields exactly one Part.
- File exactly on a Part boundary yields no trailing empty Part.
- File one byte over a boundary yields a final short Part.
- Last Part may be below the provider minimum; all others may not.
- Part count exceeding the provider maximum is rejected before any request.
- Zero-byte file is handled or rejected explicitly, not silently.
- Part numbering starts at 1 and is contiguous.

**Happy path**
- Single-file Batch completes; completion receives every Part, sorted ascending.
- Multi-file Batch completes; each Upload completes independently.
- Snapshot progress reaches exactly total bytes, never exceeds it.
- Events fire once each, in order, and not again on re-subscribe.
- Succeeded Upload's Record is removed from the store.

**Connection budget**
- Never more Parts in flight than the Budget, across the whole Batch.
- Budget divides as specified as Upload count grows.
- A slow Upload does not starve its siblings.
- Budget of one serialises Parts strictly.

**Retry**
- Transient failure on a Part retries and then succeeds.
- Attempt count is observable and accurate per Part.
- Backoff delays follow the exponential ladder, asserted against the fake clock.
- Jitter draws from the full window, asserted against the seeded random source.
- Retry budget is per Part, not shared across Parts.
- Exhausting the budget on one Part fails that Upload and no sibling Upload.
- 429 and each 5xx retry; each non-403 4xx is fatal without consuming the ladder.
- 403 triggers exactly one re-Open, then is fatal on a second 403.
- Re-Open supplies fresh URLs and those URLs are the ones subsequently used.
- Timeout is classified as retryable and honours the configured per-Attempt timeout.
- Unreadable ETag fails immediately, does not retry, and the error names the CORS fix.
- A replaced classifier is consulted and its verdict is honoured.

**Offline**
- Failure while offline parks rather than retrying.
- Parked time does not increment the Attempt count.
- Work wakes on connectivity returning and completes.
- Offline during the very first Attempt parks before any request is made.
- Offline parking disabled by configuration fails fast instead.

**Cancel**
- Cancel aborts in-flight Attempts immediately, not after the current Part.
- Cancel tears down at the provider exactly once.
- Cancel during opening, during uploading, during completing, and after failure each
  behave correctly.
- Cancel after success does not tear down an object that already exists.
- Cancelling one Upload leaves siblings running.
- Batch cancel tears down every non-terminal Upload once each.
- Resume after Cancel is refused with the distinct error.
- Cancel removes the Record from the store.

**Pause and Resume**
- Pause stops scheduling and aborts in-flight Attempts.
- Pause does not tear down at the provider.
- Resume after Pause continues and does not re-send landed Parts.
- Resume re-Opens and uses the fresh URLs.
- Pause then Cancel is terminal.
- Double Pause and double Resume are idempotent.
- Resume on a succeeded Upload is a no-op.
- Batch pause and resume fan out correctly.

**Resume after failure**
- Failed Upload is not torn down at the provider.
- Resume sends only Parts that never landed.
- Landed Parts' ETags survive the Resume and appear in completion.
- Resume resets Attempt counts so the Retry budget is fresh.
- Resume that fails again returns to failed and remains resumable.

**Durable resume**
- Record is written as Parts land, not only at the end.
- Record survives a simulated reload and is discoverable.
- Resume from a Record with a File Handle proceeds without re-selection.
- Resume where handles are unsupported reports that re-selection is required.
- Denied handle permission degrades to the re-selection path rather than throwing.
- Fingerprint match permits resume.
- Fingerprint mismatch on name, on size, and on last-modified each refuse with the
  distinct error and send no Parts.
- Records are scoped by the supplied store and are not visible across scopes.
- Stale Records are expired.
- Record for a cancelled or succeeded Upload is absent.

**Observation**
- Snapshot identity changes only when something changed, so framework renders are not
  spurious.
- Snapshot is immutable; mutating a returned snapshot affects nothing.
- Subscribing late yields current state immediately.
- Unsubscribing stops delivery.
- Per-Part progress resets visibly on a new Attempt and aggregate progress never regresses.
- Events fire once per occurrence with no duplicates on re-render.

**Transport contract**
- Opening is told which occasion it is, with resume context present only when resuming.
- Completion receives Parts sorted ascending with their ETags.
- A Transport that throws on open, on complete, and on abort is each handled distinctly.
- A Transport returning too few URLs for the Part count is rejected clearly.

**Adapters**
- Each Adapter reflects Core state changes in its framework's idiom.
- Each Adapter unsubscribes on teardown and leaves no live subscription.
- The Angular Observable interop emits equivalently to its Signal.
- Importing the Core alone pulls in no framework.

**End to end**
- One smoke test against a real S3-compatible server proves a genuine multipart upload
  completes, so the fakes cannot drift from reality on ETag ordering and completion shape.

## Out of Scope

- Signing anything. The library never holds credentials; if it cannot be done with a
  Presigned URL or a Transport call, it is not done here.
- Any storage SDK dependency.
- Presigning open, complete or abort. Those are application API calls by decision.
- UI. No components, no drop zones, no progress bars are shipped.
- Non-browser runtimes. Node uploads are a different problem with different primitives.
- Non-multipart single-`PUT` uploads.
- Server-side helpers or a reference backend implementation beyond documentation.
- Content hashing for integrity, sampled or full. Fingerprint is metadata only.
- Adaptive Part sizing or bandwidth estimation.
- Encryption of persisted Records.
- Cross-tab coordination of the same Upload.

## Further Notes

- The reference implementation is the multipart upload path of the Slapshot VFX platform.
  Its connection-budget insight is carried over deliberately; its lack of retry, its
  tear-down-on-first-failure behaviour and its unrefreshed URLs are the specific defects
  this library exists to correct.
- Leaving Uploads open on failure is the single most consequential decision here. It is
  what makes Resume possible and it is also a standing storage cost. Documentation must
  state the lifecycle-rule requirement prominently rather than in a footnote.
- Three decisions look worth recording as ADRs: leaving Uploads open on failure;
  re-Opening rather than a dedicated URL-refresh function; and Batch as the only unit.
- Shipping several Adapters, both Durable Resume paths and a documentation site is a
  large v1. Build the Core and its tests first so there is something proven to wrap.

## Amendments

Recorded rather than rewritten, so the reasoning stays legible.

**Svelte Adapter dropped.** The spec originally called for four Adapters. Svelte's
readable-store contract is satisfied exactly by the Core's own `subscribe` — it calls
back immediately with the current value and returns an unsubscriber — so the Adapter
was pass-through and `$batch` works unaided. The test that covered it now asserts the
same property against the Core, where it belongs. Three Adapters ship: React, Angular
and Vue.

**Resumability widened.** `isResumable` originally meant "some Part has not landed".
That stranded an Upload whose every Part landed but whose finalising failed: it was
not resumable and had no route to being finalised. It now turns on Parts having been
planned at all, so a failed `complete` is retried while a file rejected before
planning is still not offered a pointless Resume.

**Re-Open latch relaxed.** A 403 originally permitted one re-Open per run. An Upload
long enough to outlive its Presigned URLs twice therefore died on the second expiry.
The latch now clears whenever a Part lands, so repeated genuine expiry recovers while
back-to-back 403s with nothing landing in between remain fatal.
