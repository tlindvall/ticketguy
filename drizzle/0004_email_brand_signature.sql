CREATE TABLE "email_brand_signature" (
	"key" text PRIMARY KEY NOT NULL,
	"display_name" text NOT NULL,
	"tagline" text NOT NULL,
	"short_signoff" text NOT NULL,
	"logo" text NOT NULL,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
