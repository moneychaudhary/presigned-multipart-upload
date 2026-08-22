# Part size is chosen per file

`partSize` is derived from the file when the caller does not set one: 10 MiB, or
the smallest whole MiB that keeps the file inside the provider's Part limit,
whichever is larger.

The alternative — the fixed 10 MiB default the library shipped with first — makes
the Part limit a ceiling on file size. Providers cap an Upload at 10,000 Parts,
so 10 MiB Parts refuse anything above ~97 GiB, and the refusal arrives as
`PART_COUNT_EXCEEDED` telling the adopter to go and do arithmetic the library is
better placed to do. A 300 GiB file is a real case, and needing a configuration
change to accept one is a defect dressed as a default.

## Consequences

Part size is a property of the Upload rather than of the Batch. It is settled at
planning time, carried on the Upload State, written into the Upload Record, and
passed to Opening — which means a Batch mixing a 3 MB file and a 300 GiB one
sizes each on its own rather than punishing the small one.

The number is now less predictable. Two files in the same Batch may be cut
differently, and a file that grows past a threshold between sessions would be
cut differently on each. The Record carries the size that was used, so a Resume
always slices exactly as the first run did — this is what stops that mattering.

Rounding to whole MiB is for legibility rather than correctness. It also means
auto-sizing never chooses below 10 MiB, so small files are unaffected.

The provider limits gained `maxPartSize` and `maxObjectSize`, previously
documented but unenforced. Enforcing all four in the planner means a file that
cannot be uploaded is rejected before Opening, so it never leaves a dangling
multipart upload at the provider — see
[0001](./0001-failed-uploads-are-left-open.md) for why that matters.
