ALTER TABLE "meta_credentials" ADD COLUMN IF NOT EXISTS "source" text DEFAULT 'meta' NOT NULL;--> statement-breakpoint
ALTER TABLE "meta_credentials" ADD COLUMN IF NOT EXISTS "webhook_secret_cipher" text;--> statement-breakpoint
ALTER TABLE "meta_credentials" ADD COLUMN IF NOT EXISTS "webhook_secret_iv" text;--> statement-breakpoint
ALTER TABLE "meta_credentials" ADD COLUMN IF NOT EXISTS "webhook_secret_tag" text;--> statement-breakpoint
ALTER TABLE "meta_credentials" ADD COLUMN IF NOT EXISTS "kapso_webhook_id" text;