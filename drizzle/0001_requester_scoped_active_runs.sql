DROP INDEX "runs_one_active_opportunity_uq";
--> statement-breakpoint
CREATE UNIQUE INDEX "runs_one_active_requester_opportunity_uq" ON "runs" USING btree ("opportunity_id", "requested_by") WHERE "status" in ('created','retrieving','specialists_running','synthesizing','validating','awaiting_approval','finalizing');
