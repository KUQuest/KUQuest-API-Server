# Admin User and Wallet Endpoints Specification and Implementation Plan

## 1. Context and Problem Analysis

In the KUQuest platform:

- Each Member has one unified Wallet (`wallet_wallets`) containing 4 balance compartments (`spendingBalanceSatang`, `earningsBalanceSatang`, `fundingReservedSatang`, and `reservedForPayoutsSatang`).
- The Admin Web App (`KUQuest-Admin`) has dedicated views for:
  - **Wallets / Payouts Directory**: Viewing all user wallets with both spending and earnings balances in a single request.
  - **Users Directory (`/users`)**: Listing and searching university members (students/staff) with their status, faculty, department, and associated wallet balances.
  - **User Detail View (`/users/[id]`)**: Detailed profile information, academic registration details, wallet balances, and marketplace performance metrics.
- Prior to this implementation, the backend was missing:
  1. `GET /api/v1/admin/wallets`: Endpoint to list and search all user wallets with both balances.
  2. `GET /api/v1/admin/wallets/:walletId`: Endpoint to retrieve a specific wallet and its balance compartments.
  3. `GET /api/v1/admin/members`: Endpoint to list members with academic profile and wallet data (Issue #67 BE #279).
  4. `GET /api/v1/admin/members/:id`: Endpoint to fetch a member's complete detail and marketplace statistics (Issue #67 BE #279).

---

## 2. Ubiquitous Language & Core Rules

- **Wallet**: One wallet per student, partitioned into:
  - `spendingBalanceSatang`: Funds for escrowing Quests.
  - `earningsBalanceSatang`: Net earnings earned from completed Quests.
  - `fundingReservedSatang`: Currently active Quest escrow holds.
  - `reservedForPayoutsSatang`: Pending payout reserves.
- **Member**: A student, staff, or lecturer authenticated via Google OAuth with `@ku.th`.
- **Admin**: An operator signed in with credential auth under `auth_admin`.
- **Response Envelope**: Every response uses `{ success: true, data: ... }` or `{ success: false, error: { code, message } }`.

---

## 3. Detailed Endpoint Contracts

### 3.1 `GET /api/v1/admin/wallets`

Lists all Member Wallets with both Spending and Earnings balances in a single request.

- **Query Parameters**:
  - `status` (optional): `ACTIVE` | `FROZEN` | `SUSPENDED` | `CLOSED`
  - `userId` (optional): UUID
  - `search` (optional): string (matches first name, last name, student ID, or email)
  - `limit` (optional): integer (1–100, default 20)
  - `cursor` (optional): opaque pagination cursor
- **Response Data Shape**:

```typescript
interface AdminWalletListResponse {
  items: Array<{
    id: string; // Wallet UUID
    displayId: string; // e.g. WLT-000001
    userId: string; // Member UUID
    member: {
      firstName: string;
      lastName: string;
      studentId: string | null;
      email: string;
      telephone: string | null;
    };
    walletStatus: 'ACTIVE' | 'FROZEN' | 'SUSPENDED' | 'CLOSED';
    balances: {
      spendingBalanceSatang: number;
      earningsBalanceSatang: number;
      fundingReservedSatang: number;
      reservedForPayoutsSatang: number;
      totalBalanceSatang: number;
    };
    createdAt: string;
    updatedAt: string;
    latestTransactionAt: string | null;
  }>;
  nextCursor: string | null;
}
```

### 3.2 `GET /api/v1/admin/wallets/:walletId`

Retrieves a single wallet and its balance compartments by wallet ID.

- **Parameters**: `walletId` (UUID)
- **Response Data Shape**:

```typescript
interface AdminWalletDetailResponse {
  wallet: {
    id: string;
    displayId: string; // e.g. WLT-000001
    userId: string;
    member: {
      firstName: string;
      lastName: string;
      studentId: string | null;
      email: string;
      telephone: string | null;
    };
    walletStatus: 'ACTIVE' | 'FROZEN' | 'SUSPENDED' | 'CLOSED';
    balances: {
      spendingBalanceSatang: number;
      earningsBalanceSatang: number;
      fundingReservedSatang: number;
      reservedForPayoutsSatang: number;
      totalBalanceSatang: number;
    };
    projectionMatchesLedger: boolean;
    createdAt: string;
    updatedAt: string;
    latestTransactionAt: string | null;
  };
}
```

### 3.3 `GET /api/v1/admin/wallets/:walletId/status-history`

Returns the recorded status changes for one Wallet.

- **Parameters**: `walletId` (UUID)
- **Response Data Shape**:

```typescript
interface AdminWalletStatusHistoryResponse {
  history: Array<{
    id: string;
    walletId: string;
    fromStatus: string | null;
    toStatus: string;
    reason: string;
    actorUserId: string | null;
    actorAdminId: string | null;
    actorDisplayName: string | null;
    createdAt: string;
  }>;
}
```

`actorDisplayName` contains the actor's first and last name. It is `null` when no actor is recorded.

### 3.4 `GET /api/v1/admin/members`

Search and list all Members on the platform for the Admin User Directory table.

`displayId` is a stable Admin identifier (`MEM-######`, at least six digits). It does not replace
the UUID `id` or KU Student ID. The migration assigns existing Members in `created_at`, then UUID
order. New Members get IDs from the identity sequence. Gaps can occur; existing IDs do not change.

- **Query Parameters**:
  - `search` (optional): string (matches name, studentId, email)
  - `walletStatus` (optional): `ACTIVE` | `FROZEN` | `SUSPENDED` | `CLOSED`
  - `limit` (optional): integer (1–100, default 20)
  - `cursor` (optional): opaque cursor
- **Response Data Shape**:

```typescript
interface AdminMemberListResponse {
  items: Array<{
    id: string;
    displayId: string; // MEM-######, at least six digits
    email: string;
    firstName: string;
    lastName: string;
    studentId: string | null;
    telephone: string | null;
    academicYear: number | null;
    faculty: string | null;
    department: string | null;
    occupation: string | null;
    wallet: {
      id: string;
      walletStatus: string;
      spendingBalanceSatang: number;
      earningsBalanceSatang: number;
      totalBalanceSatang: number;
    } | null;
    createdAt: string;
  }>;
  nextCursor: string | null;
}
```

### 3.5 `GET /api/v1/admin/members/:id`

Retrieves comprehensive details for a specific Member, including profile, wallet, and marketplace performance statistics.

- **Parameters**: `id` (UUID)
- **Response Data Shape**:

```typescript
interface AdminMemberDetailResponse {
  member: {
    id: string;
    displayId: string; // MEM-######, at least six digits
    email: string;
    firstName: string;
    lastName: string;
    studentId: string | null;
    telephone: string | null;
    bio: string | null;
    academicYear: number | null;
    faculty: string | null;
    department: string | null;
    occupation: string | null;
    createdAt: string;
  };
  wallet: {
    id: string;
    walletStatus: string;
    spendingBalanceSatang: number;
    earningsBalanceSatang: number;
    fundingReservedSatang: number;
    reservedForPayoutsSatang: number;
    totalBalanceSatang: number;
    projectionMatchesLedger: boolean;
  } | null;
  stats: {
    questsCreatedCount: number;
    questsCompletedAsWorkerCount: number;
    reviewsReceivedCount: number;
    averageRating: number | null;
    payoutsCount: number;
    totalEarnedSatang: number;
    totalPaidOutSatang: number;
  };
}
```

### 3.6 Admin Member Profile collections

These reads require an enabled Admin Session. They reject a Member Session. They use a Member UUID
in the path, but every successful response identifies the Member by `displayId` (`MEM-######`).

- `GET /api/v1/admin/members/:id/profile-tags` returns up to three Profile Tags. It uses the
  existing derivation: the three most frequent Tags from completed Worker Assignments on
  `QUEST_COMPLETED` Quests. The response does not need pagination.
- `GET /api/v1/admin/members/:id/work-experiences` returns `title`, `employmentType`,
  `organization`, `description`, `startedAt`, and `endedAt`. A null `endedAt` means that the
  Work Experience is ongoing.
- `GET /api/v1/admin/members/:id/certificates` returns `name`, `issuer`, `issuedAt`, and optional
  image metadata (`contentType` and `sizeBytes`). The response does not return a storage URL,
  bucket, object key, or secret.

Work Experience and Certificate responses include `totalCount` and an opaque `nextCursor`.
Pagination uses the shared page limits. A real empty collection returns an empty list and a zero
`totalCount`. A missing Member returns `404 MEMBER_NOT_FOUND`. An invalid cursor returns an error.
The cursor must belong to the requested Member's collection. A cursor from another Member returns
`400 INVALID_CURSOR`.
A failed read remains an error; it does not return an empty list.

### 3.7 `GET /api/v1/admin/members/:id/penalty-history`

This read requires an enabled Admin Session. It rejects a Member Session. The path uses the Member
UUID. The response identifies the Member by `displayId` (`MEM-######`) and does not return record,
source, Member, or Admin UUIDs as visible identifiers.

The response includes all `memberPenaltyRecord` rows in newest-first order. Each item contains
`ladder`, `source`, `sourceDisplayId`, `sequenceNumber`, `result`, `actor`, `reasonCode`, `createdAt`,
`reviewRating`, `isEffectiveActiveMisconductPenalty`, and `reversal`. `actor` contains `type`
(`ADMIN` or `SYSTEM`) and a safe `displayName`. `reversal` links the original and reversal by
`sequenceNumber`, `result`, and `createdAt`; it does not expose a UUID. `sourceDisplayId` uses `RPT`
for a Report Case, `CND` for a Conduct Report, and the source Review's Quest Display ID (`QST`) for
a Review-ladder record. It is `null` when the source record is not available.

`confirmedMisconductCount` counts original `MISCONDUCT` records from Report Cases and Conduct
Reports created on or after Member creation. It includes `PENALTY_EXEMPT` originals and originals
with a linked reversal. It excludes `PENALTY_REVERSAL` rows. `effectiveActiveMisconductPenaltyCount`
counts only non-exempt, unreversed original Misconduct records created on or after Member creation.
`reviewLadderRecordCount` counts original `REVIEW` records separately; Review-ladder records never
increase `confirmedMisconductCount`. These values come from `memberPenaltyRecord`, not current
Member status or average rating.

`limit` uses the shared page limit (1–50). `cursor` is Member-scoped. `totalCount` covers every
penalty record, including reversals, and is not limited to the current page. Empty history returns
zero counts, an empty `items` list, and a null `nextCursor`. A missing Member returns
`404 MEMBER_NOT_FOUND`; a cursor from another Member returns `400 INVALID_CURSOR`.

---

## 4. Implementation Steps

1. **Schemas**:
   - Update `src/modules/wallet/wallet.admin.schema.ts` with wallet list query & response schemas.
   - Create `src/modules/admin/admin-member.schema.ts` with member list & detail schemas.
2. **Services**:
   - Implement `listAdminWallets` and `getAdminWalletDetail` in `src/modules/wallet/wallet.admin.service.ts`.
   - Implement `listAdminMembers` and `getAdminMemberDetail` in `src/modules/admin/admin-member.service.ts`.
3. **Controllers & Routes**:
   - Update `src/modules/wallet/wallet.admin.controller.ts` and `wallet.admin.route.ts` with `GET /` and `GET /:walletId`.
   - Create `src/modules/admin/admin-member.controller.ts` and `admin-member.route.ts` with prefix `${API_V1_PREFIX}/admin/members`.
   - Register route in `src/modules/admin/index.ts` and mount in `src/app.ts`.
4. **Integration Tests**:
   - `tests/modules/wallet/wallet.admin-list.integration.test.ts`
   - `tests/modules/admin/admin-member.integration.test.ts`
5. **Quality Gates**:
   - `bun run db:check`, `bun run lint`, `bun run typecheck`, `bun test`.
