-- ==================== profile (Auth & Profile) ====================
-- single unified profile page, no Giver/Hunter split (same user can be both)

-- tag: shared vocabulary, no module prefix — Quest assigns it, Profile derives displayed tags from it.
-- Profile tags are NOT stored: they're distinct tag(s) of Quests the user completed as hunter
-- (join QuestAssignment/Quest WHERE assignment_status = COMPLETED, once Quest is walked), same derive-don't-store
-- pattern as rating/isBanned. No profile_user_tag table.
CREATE TABLE tag (
  id   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(100) NOT NULL UNIQUE
);

CREATE TABLE profile_work_experience (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES auth_user(id),
  title           VARCHAR(120) NOT NULL,
  employment_type VARCHAR(50) NOT NULL,
  org             VARCHAR(200),
  description     VARCHAR(1000),
  started_at      DATE NOT NULL,
  ended_at        DATE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (ended_at IS NULL OR ended_at >= started_at)
);
CREATE INDEX profile_work_experience_user_idx ON profile_work_experience (user_id);

CREATE TABLE profile_certificate (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID NOT NULL REFERENCES auth_user(id),
  name           VARCHAR(200) NOT NULL,
  issuer         VARCHAR(200) NOT NULL,
  issued_at      DATE NOT NULL,
  image_file_id  UUID REFERENCES file(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX profile_certificate_user_idx ON profile_certificate (user_id);

CREATE TABLE profile_portfolio_item (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES auth_user(id),
  title       VARCHAR(120) NOT NULL,
  description VARCHAR(1000),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX profile_portfolio_item_user_idx ON profile_portfolio_item (user_id);

-- gallery: a portfolio item can have multiple images, ordered
CREATE TABLE profile_portfolio_item_image (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  portfolio_item_id UUID NOT NULL REFERENCES profile_portfolio_item(id) ON DELETE CASCADE,
  file_id           UUID NOT NULL REFERENCES file(id),
  position          INTEGER NOT NULL DEFAULT 0,
  UNIQUE (portfolio_item_id, position)
);
CREATE INDEX profile_portfolio_item_image_item_idx ON profile_portfolio_item_image (portfolio_item_id);
