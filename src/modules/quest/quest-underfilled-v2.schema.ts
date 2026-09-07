import { t, type Static } from 'elysia';

import {
  questV2States,
  questV2UnderfilledConsentDecisions,
  questV2UnderfilledDecisionValues,
  questV2UnderfilledStates,
} from './quest-v2.contract';

const unionOfLiterals = (values: readonly string[]) => t.Union(
  values.map((value) => t.Literal(value)) as [
    ReturnType<typeof t.Literal<string>>,
    ...ReturnType<typeof t.Literal<string>>[],
  ],
);

const questStateSchema = unionOfLiterals(questV2States);
const underfilledStateSchema = unionOfLiterals(questV2UnderfilledStates);
const decisionSchema = unionOfLiterals(questV2UnderfilledDecisionValues);
const consentDecisionSchema = unionOfLiterals(questV2UnderfilledConsentDecisions);
const isoDateTimeSchema = t.String({ format: 'date-time' });

export const questV2UnderfilledParamsSchema = t.Object({
  questId: t.String({ format: 'uuid' }),
});

export const questV2UnderfilledHeadersSchema = t.Object({
  'idempotency-key': t.String({
    minLength: 1,
    maxLength: 200,
    pattern: '\\S',
    description: 'Non-blank command identity for replay-safe underfilled Quest commands',
  }),
});

export const questV2UnderfilledDecisionInputSchema = t.Object(
  { decision: decisionSchema },
  { additionalProperties: false },
);

export const questV2UnderfilledConsentInputSchema = t.Object(
  { decision: consentDecisionSchema },
  { additionalProperties: false },
);

const underfilledWorkerResponseSchema = t.Object({
  workerId: t.String({ format: 'uuid' }),
  assignmentId: t.String({ format: 'uuid' }),
  decision: t.Nullable(consentDecisionSchema),
  questReward: t.Number({ minimum: 0 }),
  respondedAt: t.Nullable(isoDateTimeSchema),
});

const underfilledDecisionViewSchema = t.Object({
  status: t.Union([
    t.Literal('UNDERFILLED_DECISION_PENDING'),
    t.Literal('UNDERFILLED_DECISION_PROCEEDED'),
    t.Literal('UNDERFILLED_DECISION_CANCELLED'),
  ]),
  value: t.Nullable(decisionSchema),
  expiresAt: isoDateTimeSchema,
});

const underfilledConsentViewSchema = t.Object({
  status: t.Union([
    t.Literal('UNDERFILLED_CONSENT_NOT_STARTED'),
    t.Literal('UNDERFILLED_CONSENT_PENDING'),
    t.Literal('UNDERFILLED_CONSENT_COMPLETED'),
    t.Literal('UNDERFILLED_CONSENT_CANCELLED'),
  ]),
  expiresAt: t.Nullable(isoDateTimeSchema),
  totalCount: t.Integer({ minimum: 0 }),
  acceptedCount: t.Integer({ minimum: 0 }),
  declinedCount: t.Integer({ minimum: 0 }),
  pendingCount: t.Integer({ minimum: 0 }),
});

const underfilledDataSchema = t.Object({
  id: t.String({ format: 'uuid' }),
  questId: t.String({ format: 'uuid' }),
  questState: questStateSchema,
  state: underfilledStateSchema,
  activeWorkerCount: t.Integer({ minimum: 1, maximum: 20 }),
  headcount: t.Integer({ minimum: 2, maximum: 20 }),
  workerRewardPool: t.Nullable(t.Number({ minimum: 0 })),
  questReward: t.Nullable(t.Number({ minimum: 0 })),
  dueAt: t.Nullable(isoDateTimeSchema),
  decision: underfilledDecisionViewSchema,
  consent: underfilledConsentViewSchema,
  responses: t.Optional(t.Array(underfilledWorkerResponseSchema)),
  ownResponse: t.Optional(t.Nullable(t.Object({
    decision: t.Nullable(consentDecisionSchema),
    questReward: t.Number({ minimum: 0 }),
    respondedAt: t.Nullable(isoDateTimeSchema),
  }))),
});

export const questV2UnderfilledResponseSchema = t.Object({
  success: t.Literal(true),
  data: underfilledDataSchema,
});

export type QuestV2UnderfilledParams = Static<typeof questV2UnderfilledParamsSchema>;
export type QuestV2UnderfilledDecisionInput = Static<typeof questV2UnderfilledDecisionInputSchema>;
export type QuestV2UnderfilledConsentInput = Static<typeof questV2UnderfilledConsentInputSchema>;
export type QuestV2UnderfilledData = Static<typeof underfilledDataSchema>;
