CREATE TABLE "email_signatures" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"body_text" text NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"updated_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "email_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slot" text NOT NULL,
	"version" integer NOT NULL,
	"subject" text,
	"body_text" text NOT NULL,
	"signature_id" uuid,
	"state" text DEFAULT 'draft' NOT NULL,
	"note" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"activated_by" text,
	"activated_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "email_templates" ADD CONSTRAINT "email_templates_signature_id_email_signatures_id_fk" FOREIGN KEY ("signature_id") REFERENCES "public"."email_signatures"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "email_signatures_name_uq" ON "email_signatures" USING btree ("name");--> statement-breakpoint
CREATE UNIQUE INDEX "email_signatures_default_uq" ON "email_signatures" USING btree ("is_default") WHERE is_default;--> statement-breakpoint
CREATE UNIQUE INDEX "email_templates_slot_version_uq" ON "email_templates" USING btree ("slot","version");--> statement-breakpoint
CREATE UNIQUE INDEX "email_templates_active_uq" ON "email_templates" USING btree ("slot") WHERE state = 'active';