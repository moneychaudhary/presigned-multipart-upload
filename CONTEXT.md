# Context

Domain glossary for this library. Terms only — no implementation details.

## Status

Settled during the design session. Add terms here as the domain grows; keep
implementation detail out.

## Glossary

### Presigned URL

A URL, minted by the application's own backend, that authorises exactly one HTTP
operation against object storage for a limited time. The library only ever
*consumes* presigned URLs; it never holds storage credentials and never signs
anything itself.

This is the library's hard boundary: if an operation cannot be expressed as a
presigned URL or as a call the application makes on the library's behalf, the
library does not do it.

### Upload

One file's journey from selection to durably stored object. An Upload is the unit
the user of the library observes and controls.

### Part

One contiguous byte range of the file, uploaded independently. Parts are numbered
from 1. Every Part except the last is subject to the storage provider's minimum
part size.

### Batch

The set of Uploads the library is driving together, and the unit the application
actually holds. A single file is a Batch of one; there is no separate single-file
concept. A Batch reports its own progress and can be acted on as a whole, while
each Upload within it still succeeds, fails, and is Resumed on its own.

### Connection Budget

The ceiling on how many Parts may be in flight across the whole Batch at once.

It exists because browsers cap simultaneous connections to one host. Exceeding the
cap does not fail loudly — the surplus requests queue beneath the network layer,
where they report no progress and can time out having never been sent. The Budget
is what keeps every Part the library believes is in flight actually in flight.

### Transport

The application-supplied means by which an Upload is opened, finalised, and torn
down. Only the sending of a Part's bytes is done against a Presigned URL; opening,
finalising and tearing down are requests the application makes on the library's
behalf against its own API.

The library is deliberately ignorant of how the Transport is implemented, so that
the application retains control over authorisation, quota, and object naming.

### Opening

Asking the Transport to make an Upload ready to receive Parts. Opening serves two
occasions — starting fresh, and taking up an Upload that already exists — and the
Transport is always told which occasion it is. Both occasions yield a usable set
of Presigned URLs, because a URL minted for an earlier occasion may no longer be
honoured by the time it is used.

### Core

The framework-independent engine that owns an Upload's behaviour. The Core is the
library; everything else is a view onto it.

### Adapter

A thin binding that exposes the Core to one UI framework in that framework's own
idiom. An Adapter adds no behaviour of its own — if an Adapter needs to make a
decision, that decision belongs in the Core instead.

## The five verbs

These five terms are distinct on purpose. "Retry" in casual speech covers both
Retry and Resume below; the library never conflates them.

### Attempt

One transmission of one Part's bytes. A Part may take several Attempts to land.
Attempts are counted per Part, and that count is observable.

### Retry

A further Attempt at a Part, decided and performed by the library itself, after a
delay. Retry is automatic and never user-triggered. A Part has a finite budget of
Retries; exhausting it is what makes an Upload fail.

### Resume

A user-triggered restart of an Upload that is not finished, which picks up from
whichever Parts have not yet landed and leaves completed Parts alone. This is the
"press the button again" action. Resume is the only recovery the user drives.

### Cancel

A user-triggered, terminal end to an Upload. The Upload is torn down at the
storage provider and cannot be Resumed. Cancel is a decision to discard the work.

### Pause

A user-triggered halt that stops new Parts being sent and stops those in flight,
while keeping the Upload alive. A Paused Upload can be Resumed. Pause is a
decision to defer the work, never to discard it.

## Durability

### Durable Resume

Resuming an Upload that outlived the page it started on. An Upload survives a
reload only if two separate things survive with it: the record of which Parts
landed, and access to the original bytes. Either one missing makes Resume
impossible.

### Upload Record

The persisted account of an in-progress Upload: which object it is writing, the
provider's identifier for the Upload, and which Parts have landed. It is the half
of Durable Resume that the library can always keep.

### File Handle

A durable reference to a file on the user's device that can be stored and later
re-opened to read the same bytes. It is the half of Durable Resume that the
library can only sometimes keep — where the browser cannot provide one, the bytes
must be recovered by asking the user to select the file again.

### Record Store

Where Upload Records and File Handles are kept between page sessions. The library
provides one, and an application may supply its own — most often to scope records
to the signed-in user, or to discard them on sign-out, so that one person can
never Resume another person's Upload on a shared device.

### Fingerprint

The identity check that a set of bytes offered for Resume is the same file the
Upload Record describes. It exists because a user asked to re-select a file can
select the wrong one, and Parts from two different files must never be combined
into one object.

