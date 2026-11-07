ALTER TABLE premise_votes ADD COLUMN voter_name TEXT NOT NULL DEFAULT '';
ALTER TABLE premise_votes ADD COLUMN voter_role TEXT NOT NULL DEFAULT '';
UPDATE premise_votes SET
  voter_name=COALESCE((SELECT name FROM profiles WHERE profiles.user_id=premise_votes.user_id),''),
  voter_role=COALESCE((SELECT role FROM memberships WHERE memberships.user_id=premise_votes.user_id AND memberships.premise_id=premise_votes.premise_id),'');
