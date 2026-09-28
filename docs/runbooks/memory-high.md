# memory-high

**Severity 3, digest.** Reached from `memory_high`: an instance's resident memory has been above 80% of `MEMORY_LIMIT_BYTES` for ten minutes.

## What you are seeing

Nothing, yet, from the user's side. A digest names one instance whose memory has been high for ten minutes. If it reaches 100% the platform kills the instance — mid-request, mid-analysis — and the analyses it was running become [stuck PENDING rows](stuck-pending-analyses.md) until the reaper sweeps them.

It is a digest rather than a page because the fix is a working-day fix. If memory is climbing fast enough that it will hit the limit tonight, restart the instance now and investigate tomorrow.

## First five minutes

**1. How close, and which way is it going?**

```promql
process_resident_memory_bytes / memory_limit_bytes
```

per instance, over the last 24 hours on the operational dashboard's "Memory" panel.

- A **steady climb** that never comes back down: a leak.
- A **plateau** that is simply high: the instance is sized too small for its load.
- **Spikes** that come back down: a burst — many uploads or analyses at once.

**2. Heap or not heap?**

```promql
nodejs_heap_size_used_bytes
process_resident_memory_bytes
```

If the heap is a small part of RSS, the memory is outside JavaScript: buffers, native code, and — here — the extraction workers. PDF and DOCX parsing runs in worker threads (NFR-1.4), each with its own heap, and each holding up to a 5 MB upload while it works.

## Diagnose

- **Climbing heap, with no matching climb in traffic**: a leak in our code. The last deploy is the first suspect (`GET /api/version`, and the deploy history). A heap snapshot from the running instance says what is holding it — take one only on an instance you are about to restart, because it pauses the process.
- **RSS well above heap, and `uploads_in_flight` high**: extraction. `MAX_CONCURRENT_UPLOADS` (default 10) × 5 MB bounds upload buffering at 50 MB per instance (SRS §6.1), but each worker thread adds its own overhead on top. If this is the pattern, the instance is undersized for its upload load.
- **Plateau at a level that has crept up over weeks**: growth. SRS §6.1's model assumed 512 MB instances; check it against real traffic.

## Act

- **Restart the instance** if it will hit the limit before you can fix the cause. It drains for up to 90 seconds first.
- **Leak**: roll back to the previous image if the climb started with a deploy; otherwise find it from the snapshot.
- **Undersized**: raise the instance's memory, **and `MEMORY_LIMIT_BYTES` with it** — the alert divides by that value, so if the platform limit rises and this does not, the alert fires early; if this rises and the platform limit does not, it fires late or never.
- **Too many concurrent uploads**: lower `MAX_CONCURRENT_UPLOADS` (the server then sheds extra uploads with 503 `SERVER_BUSY`, and the upload screen tells the user to wait a few seconds and send it again), or add an instance.

## Close

Record: the instance, the shape of the curve, heap versus RSS, the cause, and whether `MEMORY_LIMIT_BYTES` matches the platform's actual limit.

---

## Walkthrough log

| Date | Where | What was exercised | Result |
|---|---|---|---|
| 2026-09-28 | isolated local rehearsal stack (not staging) | The ratio the alert computes, and the heap-versus-RSS comparison, read from `/metrics` on a running instance with `MEMORY_LIMIT_BYTES=536870912`. | `process_resident_memory_bytes` 202 MB, `nodejs_heap_size_used_bytes` 46 MB, `memory_limit_bytes` 537 MB: 37.6% of the limit, with most of the RSS outside the JavaScript heap — which is the normal shape for this process and worth knowing before reading an alert. The high-memory condition itself was not forced; the rule is covered by the promtool cases in `ops/alerts/tests/platform.yml`. |

**Staging walkthrough: not yet done** — there is no staging environment (BUILD-PLAN step 71). The platform's real memory limit is needed to set `MEMORY_LIMIT_BYTES`.
