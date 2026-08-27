# Keep Work Chat server-readable for moderation

Work Chat does not use end-to-end encryption. The server stores Message content
and private Attachment references so authorized Admins can inspect bounded
evidence, hide reported content, and retain it under the moderation policy.
TLS, database-scoped authorization, private object storage, and short-lived
signed links protect the content. This is a deliberate trade-off: moderation
and evidence retention are required for the MVP, so client-only decryption is
not compatible with the product contract.

Status: accepted.
