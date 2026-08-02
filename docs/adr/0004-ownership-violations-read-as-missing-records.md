# Ownership violations read as missing records

Certificates ([[BE-40]]) are the first resource where a Student supplies the id of a row that might belong to someone else. Profile never raised the question: it reads and writes the session's own `auth_user` row, so there is no id to get wrong. A collection under `/api/v1/profile/*` is different — the caller names one row out of everybody's, and the endpoint has to decide what to say when that row is not theirs.

It says the same thing it says about a row that does not exist: `404 CERTIFICATE_NOT_FOUND`. A Student cannot tell the two apart, which is the point. `403` would confirm that the id names a real Certificate belonging to a real Student, turning the endpoint into an oracle that answers "does this id exist?" for anyone willing to ask repeatedly. The ids are UUIDs and guessing them is not practical, but the answer is free to give away and worth nothing to an honest caller: a Student who did not create the Certificate has no use for knowing it exists.

Ownership is enforced by the query rather than checked after one. Every statement carries `where id = ? and user_id = <session>`; `updateCertificate` and `deleteCertificate` add `RETURNING`, so one statement decides existence and ownership together and hands back the row only if both held. The alternative — read the row, compare `userId`, then act — has a window between the read and the write, but the reason to avoid it is duller than a race. A forgotten comparison returns someone else's data and looks like a working endpoint. A forgotten `user_id` clause in a `where` returns nothing, and the first test to touch it fails.

That property is invisible from outside the database, which is why the ownership assertions live where [ADR 0002](0002-profile-ownership-proven-below-http.md) puts Profile's: a real database with two Students in it, asserting that one Student's read returns only their own rows and that one Student's update and delete leave the other's untouched. No test can hold a Session, so nothing above the service can reach these paths at all.

Portfolio items ([[BE-39]]) and work experience are the same shape and should do the same thing. A resource that genuinely needs to distinguish "forbidden" from "missing" — one where the caller is already entitled to know the row exists, such as an Admin acting on a Student's record — is a different case and should say so explicitly rather than inherit this by default.

Status: accepted.
