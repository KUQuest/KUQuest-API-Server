import { openapi } from '@elysia/openapi';
import {
  authOpenAPIComponents,
  authOpenAPIPaths,
} from '@/modules/auth/auth.openapi';

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
        name: 'Auth',
        description:
          'Google OAuth and database-backed session endpoints. Only @ku.th accounts are allowed.',
      },
    ],
    components: authOpenAPIComponents,
    paths: authOpenAPIPaths,
  },
});
