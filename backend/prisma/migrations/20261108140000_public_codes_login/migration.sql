-- Sequential public codes for schools and users; optional username for login.

ALTER TABLE "School" ADD COLUMN IF NOT EXISTS "publicCode" VARCHAR(32);
CREATE UNIQUE INDEX IF NOT EXISTS "School_publicCode_key" ON "School"("publicCode");

ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "publicCode" VARCHAR(32);
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "username" VARCHAR(64);
CREATE UNIQUE INDEX IF NOT EXISTS "User_publicCode_key" ON "User"("publicCode");
CREATE UNIQUE INDEX IF NOT EXISTS "User_username_key" ON "User"("username");
CREATE INDEX IF NOT EXISTS "User_publicCode_idx" ON "User"("publicCode");
CREATE INDEX IF NOT EXISTS "User_username_idx" ON "User"("username");
