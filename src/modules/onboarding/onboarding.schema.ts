import { t } from 'elysia';

export const onboardingSchema = t.Object({
    telephone: t.Optional(t.String({
        pattern: '^0[6-9][0-9]-[0-9]{3}-[0-9]{4}$',
        example: '080-000-0000',
        error: 'Telephone number must be in the format 0XX-XXX-XXXX',
    })),
    departmentId: t.Optional(t.String({
        format: 'uuid',
        example: '3fa85f64-5717-4562-b3fc-2c963f66afa6',
    })),
    studentId: t.Optional(t.String({
        pattern: '^[0-9]{10}$',
        example: '6500000000',
        error: 'Student ID must be a 10-digit number',
    })),
    academicYear: t.Optional(t.Number({ minimum: 1000, maximum: 9999, multipleOf: 1 })),
}, {
    additionalProperties: false,
    minProperties: 1,
});

export const onboardingResponseSchema = t.Object({
    success: t.Literal(true),
    data: t.Object({
        completed: t.Boolean()
    })
})

export const onboardingUpdateSchema = t.Object({
    success: t.Literal(true),
});

export const onboardingDataResponseSchema = t.Object({
    success: t.Literal(true),
    data: t.Object({
        currentUser: t.Object({
            email: t.String({ format: 'email' , example: 'student@ku.th'}),
            firstName: t.String(),
            lastName: t.String(),
            telephone: t.Nullable(t.String()),
            departmentId: t.Nullable(t.String()),
            studentId: t.Nullable(t.String()),
            academicYear: t.Nullable(t.Integer()),
        }),
    }),
})

export const academicOptionsResponseSchema = t.Object({
    success: t.Literal(true),
    data: t.Array(t.Object({
        id: t.String({ format: 'uuid' }),
        name: t.String(),
        departments: t.Array(t.Object({
            id: t.String({ format: 'uuid' }),
            name: t.String(),
        })),
    })),
});
