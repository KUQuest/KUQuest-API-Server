# Money Policy and Platform Fee Contract

Part of the [Finance Rulebook](finance-rulebook.md). Defines accepted policy for versioned Money Policy revisions, Platform Fee calculation, ceiling rounding, and operational limits.

## Versioned Money Policy revisions

- All financial calculations use an active, versioned **Money Policy Revision** (`payment_money_policy_revisions`).
- When a Quest is published or a Funding Reservation is created, the active `revision` is snapshotted into the reservation record. Subsequent policy changes do not alter existing in-flight Quest escrow terms.

## Policy fields and default parameters

| Parameter | Type | Default Value | Description |
| --- | --- | --- | --- |
| `platformFeeBps` | Basis Points (0–10000) | `200` (2.00%) | Platform Fee percentage taken on completed Quests. |
| `feeRoundingMode` | Enum (`UP`) | `'UP'` | Always rounds fee fractions up (ceiling) to the nearest Satang. |
| `minimumTopUpSatang` | Integer Satang | `100` (฿1.00) | Minimum Top-up deposit. |
| `maximumTopUpSatang` | Integer Satang | `2,000,000,000` (฿20M) | Maximum Top-up deposit. |
| `minimumPayoutSatang` | Integer Satang | `100` (฿1.00) | Minimum withdrawal request. |
| `maximumPayoutSatang` | Integer Satang | `2,000,000,000` (฿20M) | Maximum withdrawal request. |
| `minimumEarningsConversionSatang`| Integer Satang | `100` (฿1.00) | Minimum conversion amount. |
| `maximumEarningsConversionSatang`| Integer Satang | `2,000,000,000` (฿20M) | Maximum conversion amount. |
| `quoteLifetimeSeconds` | Seconds | `300` (5 minutes) | Expiry window for PromptPay QR quotes. |

## Platform Fee calculation math

- The `Quest Funding Total` is an inclusive per-slot total supplied by the Hirer.
- The Server derives the net `Quest Reward` and `Platform Fee` using integer satang arithmetic:

$$\text{Required Fee} = \left\lceil \frac{\text{Quest Reward} \times \text{platformFeeBps}}{10000} \right\rceil$$

$$\text{Platform Fee} = \text{Quest Funding Total} - \text{Quest Reward}$$

- The Server selects the greatest `Quest Reward` whose required fee fits within the `Quest Funding Total`. Any rounding remainder (up to 1 Satang) stays in the `Platform Fee`.

## Admin authoring and effective windows

- Only an Admin can author a new Money Policy revision, providing a mandatory `reason`.
- Each revision has an `effectiveFrom` timestamp and an optional `effectiveUntil` timestamp.
- Exactly one revision is active at any given moment.
