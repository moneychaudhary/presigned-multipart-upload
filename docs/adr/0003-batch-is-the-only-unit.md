# Batch is the only unit of work

There is no single-file API. A single file is a Batch of one, and every control
— start, pause, resume, cancel — acts on a Batch or on one Upload within it. The
uniform model avoids maintaining two API shapes that would drift apart.

## Consequences

The Connection Budget can be enforced across the whole Batch rather than per
file, which is the point: browsers cap simultaneous connections per host, and
exceeding the cap does not fail loudly — the surplus queues beneath the network
layer where it reports no progress and can time out having never been sent. A
per-file model cannot see enough to prevent that.

The cost is ceremony in the common case. `snapshot.uploads[0]` to reach the only
file in a Batch of one reads worse than a single-file API would, and the
simplest example in the README is a little longer than it needs to be. This was
accepted deliberately; keeping that path free of *additional* boilerplate is a
standing constraint on the API.
