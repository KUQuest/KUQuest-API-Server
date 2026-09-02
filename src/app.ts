import { questRoute } from '@/modules/quest/quest.route';
import { tagRoute } from '@/modules/tag';
import { adminPayoutRoute, payoutRoute, payoutWebhookRoute } from '@/modules/payout';
import { topUpWebhookRoute } from '@/modules/top-up';
import { questAssignmentRoute } from '@/modules/quest/quest-assignment.route';
import { questCandidateRoute } from '@/modules/quest/quest-candidate.route';
import { questProofRoute } from '@/modules/quest/quest-proof.route';
import { questReviewRoute } from '@/modules/quest/quest-review.route';
import { questDisputeRoute, questSettlementRoute } from '@/modules/quest/quest-settlement.route';
import {
  configureQuestWorkChatMembershipWriter,
  questAssignmentV2Route,
  questCandidateV2Route,
  questV2Route,
} from '@/modules/quest';
import { workChatMembershipWriter, workChatRoute } from '@/modules/work-chat';

import { Elysia } from 'elysia';

import { academicRegistrationRoute } from './modules/academic-registration';
import { authPlugin, authTestRoute, stagingTestAuthRoute } from './modules/auth';
import { certificateRoute } from './modules/certificate';
import { healthRoute } from './modules/health';
import { onboardingRoute } from './modules/onboarding';
import { portfolioRoute } from './modules/portfolio';
import { profileRoute } from './modules/profile';
import { workExperienceRoute } from './modules/work-experience';
import { localFinanceTestRoute } from './modules/local-finance-test';
import { walletRoute } from './modules/wallet';
import { corsPlugin } from './plugins/cors';
import { errorHandlerPlugin } from './plugins/error-handler';
import { openapiPlugin } from './plugins/openapi';

export const createApp = () => {
  configureQuestWorkChatMembershipWriter(workChatMembershipWriter);

  return new Elysia({
    name: 'kuquest-api',
  })
    .use(errorHandlerPlugin)
    .use(corsPlugin)
    .use(authPlugin)
    .use(stagingTestAuthRoute)
    .use(localFinanceTestRoute)
    .use(walletRoute)
    .use(openapiPlugin)
    .get('/', () => 'Hello Elysia', {
      detail: {
        tags: ['General'],
        summary: 'API root',
        description: 'Returns a basic response from the KUQuest API.',
        operationId: 'getApiRoot',
      },
    })
    .use(authTestRoute)
    .use(healthRoute)
    .use(onboardingRoute)
    .use(academicRegistrationRoute)
    .use(profileRoute)
    .use(questAssignmentRoute)
    .use(questCandidateRoute)
    .use(questProofRoute)
    .use(questReviewRoute)
    .use(questSettlementRoute)
    .use(questDisputeRoute)
    .use(questAssignmentV2Route)
    .use(questCandidateV2Route)
    .use(questV2Route)
    .use(questRoute)
    .use(certificateRoute)
    .use(portfolioRoute)
    .use(workExperienceRoute)
    .use(tagRoute)
    .use(workChatRoute)
    .use(payoutRoute)
    .use(adminPayoutRoute)
    .use(payoutWebhookRoute)
    .use(topUpWebhookRoute);
};

export const app = createApp();
