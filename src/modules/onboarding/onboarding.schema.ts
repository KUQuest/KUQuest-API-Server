import { t } from 'elysia';

export const onboardingSchema = t.Object({
    telephone : t.String({
        pattern: '^0[6-9][0-9]-[0-9]{3}-[0-9]{4}$',
        example: '080-000-0000',
        error: 'Telephone number must be in the format 0XX-XXX-XXXX',


    }),
    faculty : t.String({
        example: 'Engineering',
    }),
    studentId : t.String({
        pattern: '^[0-9]{10}$',
        example: '6500000000',
        error: 'Student ID must be a 10-digit number',
        
    }),
},{
    additionalProperties: false,
})

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
            name: t.String(),
            email: t.String({ format: 'email' , example: 'student@ku.th'}),
            firstName: t.String(),
            lastName: t.String(),
            telephone: t.Nullable(t.String()),
            faculty: t.Nullable(t.String()),
            studentId: t.Nullable(t.String()),
        }),
    }),
})
