# Upload ids are minted, not positional

An Upload's id comes from `Platform.newId()`. It used to be its position in the
Batch — `upload-1`, `upload-2` — which is fine as a label and wrong as a key.

The Upload Record is stored under that id. A position is unique within one Batch
and nowhere else, so a second Batch in the same tab, or any Batch after a reload,
mints `upload-1` again and its Record silently overwrites the first. The Record
is the half of Durable Resume the library claims it can *always* keep; losing it
leaves a multipart upload open at the provider, which
[0001](./0001-failed-uploads-are-left-open.md) explains is the state that costs
money and does not show up in a listing. `scopeStore` does not help — it scopes
by owner, and the collision is inside one owner.

Nothing in `RecordStore` said ids had to be unique across Batches, and nothing
produced ids that were.

## Consequences

Id generation joins `now` and `random` behind the Platform seam, for the same
reason they are there: it is ambient nondeterminism, and the Core may not reach
for it directly. The browser Platform uses `crypto.randomUUID`, falling back to
`getRandomValues` outside a secure context — a local dev server over http is not
one, and this must not break there.

The fake Platform counts, so a test still sees `upload-1` and reads the way it
did. Two Batches sharing one Platform get distinct ids, which is what a browser
gives them.

`Platform` gains a required member, so an application supplying its own must add
it. That is deliberate: an id source that repeats is a data-loss bug, and making
it optional would let one be omitted silently.

Ids are opaque. They are not ordered, not meaningful, and not constructible —
callers take them from `UploadSnapshot.id`. The documentation used to show
`batch.pause("upload-1")`, which taught exactly the wrong thing.
