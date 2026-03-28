#224 Fix: GET /api/notifications has no pagination — response payload grows unbounded as notifications accumulate
Repo Avatar
stellarmarket-labs/stellar-market
Problem
`GET /api/notifications` returns all notifications for the authenticated user in a single query with no `LIMIT`. Active users accumulate hundreds of notifications over time; this single query will degrade in performance and eventually cause memory/timeout issues.

Additionally the route returns the entire dataset to the client, making the response slow to render on the frontend notification page.

Proposed Fix
Add cursor- or offset-based pagination consistent with the job and transaction routes:

Accept `page` (default 1) and `limit` (default 20, max 100) query params.
Return a `meta` object: `{ total, page, limit, totalPages }`.
Add a database index on `(user_id, created_at DESC)` if not already present.
GET /api/notifications?page=1&limit=20
Acceptance Criteria
 Route accepts `page` and `limit` query params.
 Response includes `data` array and `meta` pagination object.
 `page` and `limit` are cast to integers (mirrors fix in #145).
 Without params, defaults to page 1, limit 20.
 Unit test asserts pagination metadata is correct.


 #223 Fix: POST /api/disputes does not verify the requester is a participant of the job — any authenticated user can open a dispute
Repo Avatar
stellarmarket-labs/stellar-market
Problem
The dispute creation endpoint (`POST /api/disputes`) only checks that the user is authenticated. It does not verify that the requesting user is either the client or the hired freelancer for the referenced job. Any logged-in user can open a dispute against any job.

This can be abused to:

Lock jobs in a `DISPUTED` state maliciously.
Trigger on-chain dispute flows for jobs the caller is unrelated to.
Steps to Reproduce
Log in as User A.
Find a job that belongs to User B and User C.
`POST /api/disputes` with that `jobId`.
Dispute is created successfully — 403 should have been returned.
Fix
In the dispute creation handler, after fetching the job:

if (job.clientId !== req.user.id && job.freelancerId !== req.user.id) {
  return res.status(403).json({ error: 'Not a participant of this job' });
}
Also verify the job status is `ACTIVE` or `FUNDED` before allowing a dispute.

Acceptance Criteria
 Returns 403 when caller is not the client or freelancer on the job.
 Returns 400 when job is not in a disputable state.
 Existing participant-created disputes still succeed.
 Unit/integration test covers the unauthorized case.


 #222 Fix: GET /api/jobs/:id does not include escrow funding status — frontend has no reliable source of truth for whether a job is funded
Repo Avatar
stellarmarket-labs/stellar-market
Problem
`GET /api/jobs/:id` returns the Postgres job record, but the `escrow_status` field is either absent or always `null`. The on-chain escrow state (Unfunded / Funded / Completed / Disputed) is never fetched from the Soroban contract and merged into the response.

As a result:

The frontend cannot conditionally show "Fund Job" vs "View Escrow" CTAs.
Issue #202 (escrow status badge) cannot be properly fixed without this data.
The dispute creation guard (should block unfunded jobs) has no reliable source of truth.
Proposed Fix
In the job detail handler, after fetching the DB record:

If `on_chain_job_id` is present, call the Soroban RPC `get_job_status` view function.
Merge the result into the response as `escrow_status: 'UNFUNDED' | 'FUNDED' | 'COMPLETED' | 'DISPUTED'`.
Cache the result for 30 s to avoid hammering the RPC on repeated page loads.
If the RPC call fails, fall back to the DB-stored status and log a warning.

Acceptance Criteria
 `GET /api/jobs/:id` response includes `escrow_status`.
 Value reflects the current on-chain state for jobs with a valid `on_chain_job_id`.
 Returns DB fallback (not an error) when RPC is unavailable.