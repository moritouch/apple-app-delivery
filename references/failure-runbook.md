# Failure and resume runbook

## HTTP failures

| Result | Response |
|---|---|
| `400` / `422` | Fix the request or missing metadata. Do not retry unchanged. |
| `401` | Check JWT time, key ID, issuer ID, key file, and host clock. |
| `403` | Check key role, app access, provisioning access, agreements, and revoked keys. |
| `404` | Re-resolve IDs from the target app; do not guess. |
| `409` | Re-fetch live state and compare it with the intended resource. Never blindly repeat a POST. |
| `429` | Honor `Retry-After` or rate-limit headers and back off. |
| `5xx` / network | Retry reads with bounded backoff. Re-fetch state before retrying a mutation. |

`asc-api.mjs` retries only GET requests for `429`, `5xx`, and transient network
errors. It deliberately sends each mutation once. Include the sanitized Apple
request ID in an incident report, but never include JWTs, signed upload URLs,
private keys, demo passwords, or tester email lists.

## Prepared upload provenance

Both upload paths atomically reserve the requested provenance path before they
contact Apple. The stderr line has this form:

```text
Prepared provenance reservation: /absolute/path/upload-provenance.json sha256=HASH
```

At that point the receipt has `uploadCompleted=false`. A normal successful
command changes the same file to `uploadCompleted=true`; downstream TestFlight
and App Store commands reject a prepared receipt. If execution fails or is
interrupted after the reservation:

1. Preserve the prepared receipt and the exact reservation SHA-256 from stderr.
   Do not edit, delete, overwrite, or complete it yet.
2. Do not blindly retry the upload. Apple may have accepted the bytes even when
   the local command did not receive a successful result.
3. Query App Store Connect by the exact bundle ID, platform, marketing version,
   and build number. Confirm the remote build's identity and intended audience;
   polling with `wait-build` is read-only and can resume after a timeout.
4. Only when remote success is positively established and the identity/audience
   match, complete the reservation with its exact hash, then read the completed
   receipt:

```bash
node scripts/upload-provenance.mjs complete \
  --file /absolute/private/release/upload-provenance.json \
  --reservation-sha256 EXACT_PREPARED_RECEIPT_SHA256

node scripts/upload-provenance.mjs read \
  --file /absolute/private/release/upload-provenance.json
```

Completion rechecks the receipt against the policy on its original `createdAt`
date, so policy expiry alone does not erase historical evidence. Every later
App Store Connect distribution or release command independently checks the
current bundled policy. After an official re-verification, an existing receipt
can continue only if the newly selected current dated entry preserves the exact
toolchain identity and acceptance data and differs from the receipt-bound entry
only in `verifiedAt` and/or `validUntil`.

If remote success cannot be proven, do not complete the receipt. Preserve it as
incident evidence. Apple may already have consumed the build number; after a
separate decision, use a new build number and a new provenance output path for
a new upload rather than overwriting or deleting the ambiguous reservation.

## Asynchronous states

- Build not visible after upload: keep polling by app, platform, marketing
  version, and build number. Do not upload the same processed build number
  again.
- Build `PROCESSING`: resume polling. A timeout is pending, not failed.
- Build `FAILED` or `INVALID`: inspect delivery logs, fix the binary, increment
  the build number when Apple has consumed it, and upload a new build.
- `MISSING_EXPORT_COMPLIANCE`: obtain a human-approved answer or declaration,
  then update the build.
- Beta review `REJECTED`: report the reason and stop. Do not auto-resubmit.
- Review submission `UNRESOLVED_ISSUES` or version `REJECTED`: report the live
  state and use App Store Connect to read/respond to messages. Do not edit or
  resubmit without a new decision.
- Version `PENDING_APPLE_RELEASE`: Apple is holding the version; do not issue a
  manual release request.
- Version `PROCESSING_FOR_DISTRIBUTION`: keep polling; do not submit another
  release request.
- Screenshot `AWAITING_UPLOAD`: the reservation exists but upload or commit is
  incomplete. The helper intentionally does not claim it can identify which
  multipart operations Apple accepted. Record the screenshot ID, run `status`,
  and stop; do not rerun `upload` or create another reservation. Reconcile the
  asset in App Store Connect, then obtain a separate decision before any
  deletion, replacement, or newly reserved upload.
- Screenshot `UPLOAD_COMPLETE`: keep polling the same screenshot ID.
- Screenshot `FAILED`: report the asset errors and stop. Deletion/replacement
  is a separate destructive action and needs a new decision.

## Idempotency rules

- Identify a build with bundle ID, platform, marketing version, build number,
  and artifact SHA-256.
- Reuse an existing matching resource after a network ambiguity. Fail if the
  same version/build number refers to an unexpected artifact or audience.
- Store returned resource IDs in the release record after every successful
  mutation.
- Re-run `status` before resuming. Continue from the first incomplete phase;
  never replay every POST from the beginning.
- Regenerate the manifest digest and obtain a new approval whenever any target,
  build, metadata, price, territory, release policy, or phased-release setting
  changes.
