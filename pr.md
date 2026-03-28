# 🚀 Proposed Changes

This PR addresses three critical issues in the backend related to pagination, security, and data visibility for jobs and notifications.

## 🛠️ Summary of Changes

### 1. Paginated Notifications ([#224](https://github.com/stellarmarket-labs/stellar-market/issues/224))
- Updated `GET /api/notifications` to support `page` and `limit` query parameters.
- Default values: `page=1`, `limit=20`.
- Response now uses a consistent structure with a `data` array and a `meta` object containing pagination details (`total`, `page`, `limit`, `totalPages`).
- Added a composite database index on `(userId, createdAt DESC)` in Prisma schema for optimized query performance.
- Validated integer coercion for query parameters.
- Added unit tests to verify pagination logic and metadata correctness.

### 2. Dispute Creation Security ([#223](https://github.com/stellarmarket-labs/stellar-market/issues/223))
- Enhanced `POST /api/disputes` to verify that the requesting user is a participant of the job (either the client or the hired freelancer).
- Returns `403 Forbidden` if a non-participant attempts to raise a dispute.
- Added verification that the job is in a disputable state (`IN_PROGRESS` or `FUNDED`).
- Returns `400 Bad Request` if the job state is not valid for a dispute.
- Updated error handling to return appropriate HTTP status codes using `createError`.

### 3. On-Chain Escrow Status Integration ([#222](https://github.com/stellarmarket-labs/stellar-market/issues/222))
- Updated `GET /api/jobs/:id` to fetch the real-time escrow status from the Soroban contract using RPC simulation.
- Implemented `getOnChainJobStatus` in `ContractService`.
- Added a 30-second cache for on-chain status to balance data freshness and RPC load.
- Implemented graceful fallback: if the RPC call fails or the job is not on-chain, it falls back to the status stored in the database.
- Mapped Soroban contract statuses to frontend-compatible strings: `UNFUNDED`, `FUNDED`, `COMPLETED`, `DISPUTED`.

## 🧪 Testing and Verification
- Ran existing unit tests for notifications.
- Verified pagination structure in `GET /api/notifications`.
- Verified participant checks for disputes.
- Manually checked that `escrow_status` is correctly merged into the job detail response.

## 📦 Dependencies / Migration
- Requires a database migration to add the new index: `npx prisma migrate dev`.
