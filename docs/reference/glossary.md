# Glossary

These words are used precisely and consistently across the API, the docs and the
source. Where everyday speech blurs two of them together, the library does not.

## Upload

One file's journey from selection to durably stored object. The unit you
observe and control.

## Part

One contiguous byte range of a file, uploaded independently. Numbered from 1.
Every part except the last is subject to the provider's minimum part size.

## Batch

The set of uploads driven together, and the thing you actually hold. **A single
file is a batch of one** — there is no separate single-file concept. A batch
reports its own progress and can be acted on as a whole, while each upload
inside it still succeeds, fails and resumes on its own.

## Presigned URL

A URL, minted by your backend, authorising exactly one operation against object
storage for a limited time. This library only ever *consumes* them. It holds no
credentials and signs nothing.

## Transport

Your three functions — open, complete, abort — through which an upload is made
ready, finalised and torn down. Only part bytes go to a presigned URL; these do
not. The library is deliberately ignorant of how they are implemented, so
authorisation, quota and object naming stay yours.

## Opening

Asking the transport to make an upload ready to receive parts. It serves **two
occasions** — starting fresh, and taking up an upload that already exists — and
the transport is always told which. Both yield fresh presigned URLs, because a
URL minted earlier may no longer be honoured.

## Connection Budget

The ceiling on how many parts may be in flight across the whole batch.

It exists because browsers cap simultaneous connections per host. Exceeding the
cap does not fail loudly — the surplus queues beneath the network layer, where
it reports no progress and can time out having never been sent.

## The five verbs

Casual speech uses "retry" for two different things. The library never conflates
them.

### Attempt

One transmission of one part's bytes. A part may take several. The count is
observable at `upload.parts[i].attempts`.

### Retry

A further attempt at a part, decided and performed by the library after a delay.
**Automatic, never user-triggered.** Each part has a finite budget; exhausting
it is what fails an upload.

### Resume

A **user-triggered** restart of an unfinished upload, picking up from whichever
parts have not landed and leaving landed ones alone. This is the "press the
button again" action, and the only recovery a person drives.

### Cancel

A user-triggered, **terminal** end. The upload is torn down at the provider and
cannot be resumed. A decision to *discard* the work.

### Pause

A user-triggered halt that stops new parts and those in flight while keeping the
upload alive. A decision to *defer* the work, never to discard it.

## Durable Resume

Resuming an upload that outlived the page it started on. It needs two things to
survive together: the record of what landed, and access to the original bytes.
Either one missing makes it impossible.

## Upload Record

The persisted account of an in-progress upload — object key, provider upload id,
which parts landed and their ETags, the part plan, the file descriptor. The half
of durable resume the library can always keep.

## File Handle

A durable reference to a file on the user's device that can be stored and later
re-opened. The half of durable resume the library can only *sometimes* keep —
where the browser cannot provide one, the bytes must be recovered by asking the
user to select the file again.

## Record Store

Where records and handles live between page sessions. Swappable, so an
application can scope them to the signed-in user and clear them on sign-out —
one person must never resume another's upload on a shared device.

## Fingerprint

The check that bytes offered for a resume are the same file the record
describes. It exists because a user asked to re-select can pick the wrong file,
and parts of two different files must never be combined into one object.

## Core

The framework-independent engine that owns an upload's behaviour. The core *is*
the library; everything else is a view onto it.

## Adapter

A thin binding exposing the core to one UI framework in that framework's idiom.
An adapter adds no behaviour of its own — if one needs to make a decision, that
decision belongs in the core.

## Platform

The single door between the core and the outside world: sending bytes, time,
randomness, connectivity, file handles. Nothing in the core reaches past it,
which is what makes every behaviour testable without mocking internals.
