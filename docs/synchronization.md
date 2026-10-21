# Shared-state synchronization

The API encrypts guest projections with a fresh random nonce for each read.
Ciphertext inequality is not proof of a business-data change.

- Keep the revision of the last **accepted** response, not the last response
  fetched. A response deferred because of typing must remain discoverable,
  including a real change with the same database timestamp.
- An unchanged stable source revision avoids decoding/re-rendering. If revision
  inspection is unavailable or an older response has no revision, compare
  deterministic plaintext in the current access scope. Object-key order and
  the root save timestamp are not business changes; array order and edit clocks
  remain significant.
- In the guest scope, omitted/empty roster month maps and implicit full-meal
  print defaults are equivalent. Never compare hidden normalized private
  defaults against the public projection as if they were peer edits.
- A changed input that has not emitted `change` stays protected while focused,
  even after the usual six-second typing guard. Do not advance its accepted
  revision or replace its DOM while the response is deferred.
- A confirmed save is still full-state CAS with existing per-field clocks,
  tombstones, preserved history and dated backups. A no-op read never writes.
  Revision/fingerprint caches remain memory-only and reset on administrator lock.

`tools/test_cloud_sync_identity.cjs` exercises the encrypted app against a
synthetic backend, including fresh ciphertext, failed metadata reads, legacy
responses, unchanged-save timestamps, same-time edit races, uncommitted input,
guest/admin own-save acknowledgements and a real edit reaching a second client
exactly once. The cloud egress/settings, sales persistence, store and access
tests cover the remaining shared-state consumers. No production fixture writes
are required to verify a release.
