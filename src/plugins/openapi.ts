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
          'Student Google OAuth and Admin credential authentication with separate database-backed sessions.',
      },
      {
        name: 'Onboarding',
        description:
          'Debug scaffolding, not a contract — superseded by Academic Registration below. Do not integrate against these routes or treat their validation rules as canonical.',
      },
      {
        name: 'Academic Registration',
        description:
          "Authenticated endpoints for the Student's resumable first-run registration step (name, telephone, occupation, Student ID, Faculty/Department, Terms acceptance) — the canonical contract mobile integrates against.",
      },
      {
        name: 'Profile',
        description: 'Authenticated Student profile endpoints.',
      },
      {
        name: 'Portfolio',
        description: "Authenticated endpoints for managing the current Student's portfolio gallery.",
      },
      {
        name: 'Certificates',
        description: "Authenticated endpoints for managing the current Student's profile certificates.",
      },
    ],
    components: authOpenAPIComponents,
    paths: authOpenAPIPaths,
  },
});
