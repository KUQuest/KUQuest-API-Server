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
    ],
  },
});