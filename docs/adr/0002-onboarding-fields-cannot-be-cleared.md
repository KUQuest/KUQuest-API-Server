# Onboarding fields cannot be cleared after being set

Onboarding fields begin as nullable because a Student may complete onboarding incrementally. Once `studentId`, `telephone`, `departmentId`, or `academicYear` has a value, the API permits replacing it only with another valid non-null value; explicit `null` updates are rejected with `400 Bad Request` so onboarding data cannot be accidentally cleared.
