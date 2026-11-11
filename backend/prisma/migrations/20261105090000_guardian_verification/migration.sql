-- Guardian access is opt-in after Principal review. Existing relationships
-- are intentionally unverified until the school confirms them.
ALTER TABLE "Student"
ADD COLUMN "guardianVerified" BOOLEAN NOT NULL DEFAULT false;
