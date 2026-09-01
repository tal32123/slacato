ALTER TABLE "approval_requirement_entries" DROP CONSTRAINT IF EXISTS "approval_requirement_entries_category_check";
--> statement-breakpoint
ALTER TABLE "approval_requirement_entries" DROP CONSTRAINT IF EXISTS "approval_requirement_entries_category_ck";
--> statement-breakpoint
ALTER TABLE "approval_requirement_entries" ADD CONSTRAINT "approval_requirement_entries_category_ck" CHECK ("category" in ('commercial_discount','legal_terms','evidence_review','customer_communication','customer_concession'));
