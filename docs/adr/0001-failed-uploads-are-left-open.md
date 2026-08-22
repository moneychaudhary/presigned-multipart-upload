# Failed Uploads are left open at the provider

When a Part exhausts its Retry budget we mark the Upload failed but deliberately
do **not** call the Transport's abort — the multipart upload stays open at the
storage provider, keeping the Parts that already landed. Tearing it down would
be tidier and cheaper, but it would also discard the work, which makes Resume
impossible and defeats the reason this library exists.

## Consequences

An Upload nobody returns to sits at the provider indefinitely, accruing storage
charges for Parts that are invisible in an ordinary object listing. **A bucket
lifecycle rule aborting incomplete multipart uploads is therefore not optional**,
and the documentation states this in the getting-started guide, the backend
contract and its own page rather than in a footnote.

Cancel is the deliberate exception: it *does* tear down, because cancelling is a
decision to discard rather than defer.

A related consequence surfaced later: because resumability originally meant
"some Part has not landed", an Upload whose every Part landed but whose
finalising failed was not resumable and was stranded unfinalised. Resumability
now turns on Parts having been planned at all.
