import { openapi } from '@elysia/openapi';

export const openapiPlugin = openapi({
  documentation: {
    info: {
      title: 'KUQuest API',
      version: '1.0.0',
      description: 'API documentation for the KUQuest platform',
    },
    tags: [
      {
        name: 'General',
        description: 'General API endpoints',
      },
      {
        name: 'Health',
        description: 'Endpoints for checking API availability',
      },
      {
        name: 'Wallet',
        description: 'Current-user balances, policy, and wallet activity.',
      },
      {
        name: 'Earnings conversion',
        description: 'Irreversible earnings-to-spending conversion.',
      },
      {
        name: 'Xendit webhooks',
        description: 'Authenticated provider events persisted before acknowledgement.',
      },
    ],
    components: {
      securitySchemes: {
        sessionAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'Session JWT',
        },
        xenditWebhookAuth: {
          type: 'apiKey',
          in: 'header',
          name: 'x-callback-token',
        },
      },
    },
  },
});
