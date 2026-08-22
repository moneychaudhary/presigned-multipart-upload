# Presigned URLs are a supply, not a list

The Core no longer holds an array of URLs alongside the Parts. It holds a supply
that Parts draw from: a Part asks for its URL immediately before sending, and
asks for the supply to be replaced when one is refused. Every URL carries the
generation that minted it.

The previous design kept `urls: string[]` on the Upload State, minted whole by an
Opening, and recovered from expiry by re-Opening under a boolean latch. That was
correct for one Part at a time and wrong for any real Upload:

- Presigned URLs for an Upload expire **together**, so at the shipped default of
  five Parts in flight, an expiry is felt by all five in the same tick. The first
  set the latch and re-Opened; the other four consulted the classifier, were told
  the Upload had already re-Opened, and were ruled fatal — one of which aborted
  the run and killed the re-Open in progress. The library's headline recovery
  feature worked only at `concurrency: 1`, which is what the tests covering it
  happened to pin.
- Re-Opening to recover one Part re-mints every URL of the Upload. A 300 GiB file
  is ~9,900 Parts, so an expiry cost several megabytes of signing to repair one
  request — repeatedly, since a transfer that long outlives its URLs many times.
- The latch was per-Upload state consulted by a per-Part loop, and its meaning was
  described three different ways across three files.

## Consequences

**Concurrent Parts meeting one expiry share one Refresh.** A Part whose Attempt
failed on an older generation finds the supply already replaced and pays nothing.
This is the fix for the bug above, and it holds whichever way URLs are obtained.

**The Core owns termination, not the classifier.** A Refresh budget of one between
landed Parts lives in the supply. `ClassifyContext.alreadyReopened` is still
supplied and still means what it says, but a replacement classifier that always
answers `"reopen"` can no longer loop the Core — it could before.

**Transports may sign Parts on demand.** `Transport.signParts` is optional. Given
it, Opening settles only the Upload's identity, URLs are minted a window ahead of
what is in flight, and an expiry is repaired by re-signing rather than re-Opening.
Without it, nothing changes: Opening mints everything, and a Refresh is an Opening.
Two adapters, one seam.

**This narrows [0002](./0002-opening-serves-two-occasions.md).** Opening still
serves its two occasions — starting fresh and taking up an existing Upload — and
a Transport that cannot sign still uses it for expiry too. But expiry is no longer
*inherently* an occasion for Opening, which is the part of 0002 this supersedes.
Opening conflated "which Upload is this" with "give me credentials"; those have
different natural granularity, and separating them is what makes the large-file
case affordable.

**A Refresh discards URLs that were never used.** Conservative on purpose: the
library cannot tell which of the URLs it holds share the refused one's expiry, and
serving a URL that is about to be refused costs a whole round trip to discover.
