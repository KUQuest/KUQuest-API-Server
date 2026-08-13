-- ==================== auth (Auth & Profile) ====================

-- faculty/department/occupation: unprefixed, shared lookup vocabulary (not auth-specific)
CREATE TABLE faculty (
  id   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(100) NOT NULL UNIQUE
);

-- renamed from `major` (migration 0007) — same shape, name only
CREATE TABLE department (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  faculty_id UUID NOT NULL REFERENCES faculty(id),
  name       VARCHAR(100) NOT NULL,
  UNIQUE (faculty_id, name)
);

-- added migration 0007 (BE-94, Academic Registration). Distinct from the application flow —
-- drives whether Academic Registration requires a student_id for this occupation, so the
-- server doesn't hardcode a name comparison. Seeded (migrations 0008/0010): Student (true),
-- Lecturer and Staff (false).
CREATE TABLE occupation (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name                VARCHAR(100) NOT NULL UNIQUE,
  requires_student_id BOOLEAN NOT NULL
);

-- auth_user (merged app User + better-auth user)
-- email is CITEXT, not TEXT (design decision 2026-08-09, datatype audit): auth_admin.email
-- already needed case-insensitive uniqueness (lower(email) functional index), auth_user.email
-- had none — inconsistent and a real dup-account risk. CITEXT fixes both natively, no lower()
-- index needed. Needs `CREATE EXTENSION citext` alongside pgcrypto.
-- image: better-auth's core `image` field, no equivalent in the design — avatars live in
-- imageFileId/file instead, this column stays unused (kept only because better-auth writes it).
-- academic_year: stores a Gregorian year (e.g. 2026), not a 1-8 year-level ordinal — check
-- range widened migration 0004 (BE-45, "Store onboarding academic year as Gregorian year").
-- occupation_id/terms_accepted_at/terms_version: added migration 0007 (BE-94/BE-95, Academic
-- Registration). termsAcceptedAt is stamped server-side from client-sent termsVersion —
-- deliberate, prevents spoofed acceptance time.
CREATE TABLE auth_user (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email             CITEXT NOT NULL UNIQUE,
  email_verified    BOOLEAN NOT NULL DEFAULT false,
  image             VARCHAR(2048),
  first_name        VARCHAR(100) NOT NULL,
  last_name         VARCHAR(100) NOT NULL,
  image_file_id     UUID,
  bio               VARCHAR(1000),
  student_id        VARCHAR(10),
  telephone         VARCHAR(12),
  department_id     UUID REFERENCES department(id),
  academic_year     INTEGER,
  occupation_id     UUID REFERENCES occupation(id),
  terms_accepted_at TIMESTAMPTZ,
  terms_version     VARCHAR(50),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (academic_year IS NULL OR academic_year BETWEEN 1000 AND 9999)
);
CREATE UNIQUE INDEX auth_user_student_id_uidx ON auth_user (student_id) WHERE student_id IS NOT NULL;
CREATE INDEX auth_user_department_id_idx ON auth_user (department_id);

-- file: shared S3/RustFS object pointer (bucket+key only; app builds the URL from config, not stored here)
-- deleted_at: soft-delete marker, added migration 0003 — not in the original design.
CREATE TABLE file (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bucket              VARCHAR(63) NOT NULL,
  object_key          VARCHAR(1024) NOT NULL,
  content_type        VARCHAR(255) NOT NULL,
  size_bytes          BIGINT NOT NULL,
  uploaded_by_user_id UUID REFERENCES auth_user(id),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at          TIMESTAMPTZ,
  UNIQUE (bucket, object_key)
);
CREATE INDEX file_uploaded_by_user_id_idx ON file (uploaded_by_user_id);

ALTER TABLE auth_user ADD CONSTRAINT auth_user_image_file_id_fkey FOREIGN KEY (image_file_id) REFERENCES file(id);

-- auth_admin (fully separate identity, zero FK overlap with auth_user)
-- login identifier is email (credentials plugin), not username — username kept as optional display handle
-- email_verified/image: better-auth core fields wired on, added migration 0006 — same
-- unused-but-required-by-the-library situation as auth_user.image above.
CREATE TABLE auth_admin (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username       VARCHAR(100),
  email          CITEXT NOT NULL,
  email_verified BOOLEAN NOT NULL DEFAULT false,
  image          VARCHAR(2048),
  first_name     VARCHAR(100) NOT NULL,
  last_name      VARCHAR(100) NOT NULL,
  image_file_id  UUID REFERENCES file(id),
  disabled_at    TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX auth_admin_email_uidx ON auth_admin (email);
CREATE UNIQUE INDEX auth_admin_username_uidx ON auth_admin (lower(username)) WHERE username IS NOT NULL;

-- auth_session (shared, polymorphic: exactly one of user_id/admin_id set)
CREATE TABLE auth_session (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID REFERENCES auth_user(id) ON DELETE CASCADE,
  admin_id   UUID REFERENCES auth_admin(id) ON DELETE CASCADE,
  token      VARCHAR(255) NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  ip_address INET,
  user_agent VARCHAR(512),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (num_nonnulls(user_id, admin_id) = 1)
);
CREATE INDEX auth_session_user_id_idx ON auth_session (user_id);
CREATE INDEX auth_session_admin_id_idx ON auth_session (admin_id);

-- auth_account (shared, polymorphic: exactly one of user_id/admin_id set)
CREATE TABLE auth_account (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                   UUID REFERENCES auth_user(id) ON DELETE CASCADE,
  admin_id                  UUID REFERENCES auth_admin(id) ON DELETE CASCADE,
  account_id                VARCHAR(255) NOT NULL,
  provider_id               VARCHAR(100) NOT NULL,
  access_token              VARCHAR(8192),
  refresh_token             VARCHAR(8192),
  id_token                  VARCHAR(8192),
  access_token_expires_at   TIMESTAMPTZ,
  refresh_token_expires_at  TIMESTAMPTZ,
  scope                     VARCHAR(2048),
  password                  VARCHAR(255),
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (num_nonnulls(user_id, admin_id) = 1),
  CHECK (admin_id IS NULL OR provider_id = 'credential'),
  UNIQUE (provider_id, account_id)
);
CREATE INDEX auth_account_user_id_idx ON auth_account (user_id);
CREATE INDEX auth_account_admin_id_idx ON auth_account (admin_id);

-- auth_verification (better-auth, unscoped to user/admin)
-- identifier is an email string for both auth_user (Google OAuth) and auth_admin (credentials login) —
-- the two namespaces don't collide only because auth_user.email and auth_admin.email are each independently
-- UNIQUE; a real address could still in principle be registered on both sides. No schema-level dedup across
-- the two — flagged, not fixed, would need app-layer cross-check at admin-account creation time if it matters.
CREATE TABLE auth_verification (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  identifier CITEXT NOT NULL,
  value      VARCHAR(2048) NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX auth_verification_identifier_idx ON auth_verification (identifier);
