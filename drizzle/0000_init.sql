CREATE TABLE "account" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"password" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "adapter_configs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_id" text NOT NULL,
	"implementation" text NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"capabilities" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"access_approval_evidence" text,
	"monitoring_allowed" boolean DEFAULT false NOT NULL,
	"retention_days" integer,
	"daily_call_limit" integer,
	"rate_per_second" integer,
	"secret_ref" text,
	"last_health" jsonb,
	"reviewed_by" text,
	"reviewed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "adapter_configs_source_id_unique" UNIQUE("source_id")
);
--> statement-breakpoint
CREATE TABLE "advice_outcomes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"advice_run_id" uuid NOT NULL,
	"outcome_kind" text NOT NULL,
	"verified_amount_cents" integer,
	"provenance" text NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "advice_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"benchmark_run_id" uuid,
	"trend_run_id" uuid,
	"verified_offer_observation_ids" jsonb NOT NULL,
	"customer_priorities" jsonb NOT NULL,
	"policy_version" text NOT NULL,
	"decision" text NOT NULL,
	"reason_codes" jsonb NOT NULL,
	"abstentions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"next_checkpoint_at" timestamp with time zone,
	"stop_conditions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"packet" jsonb NOT NULL,
	"packet_hash" text NOT NULL,
	"evidence_expires_at" timestamp with time zone,
	"invalidated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "attachments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"message_id" uuid NOT NULL,
	"provider_attachment_id" text,
	"filename" text,
	"declared_mime_type" text,
	"detected_mime_type" text,
	"byte_length" integer,
	"sha256" text,
	"width" integer,
	"height" integer,
	"media_id" uuid,
	"validation_state" text DEFAULT 'pending' NOT NULL,
	"validation_reason" text,
	"purge_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor" text NOT NULL,
	"action" text NOT NULL,
	"entity_kind" text NOT NULL,
	"entity_id" text NOT NULL,
	"revision" integer,
	"diff" jsonb,
	"trace_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "benchmark_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"target_event_id" uuid NOT NULL,
	"target_context" jsonb NOT NULL,
	"cohort_filters" jsonb NOT NULL,
	"fallbacks_applied" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"representative_snapshot_ids" jsonb NOT NULL,
	"independent_event_count" integer NOT NULL,
	"median_cents" integer,
	"p25_cents" integer,
	"p75_cents" integer,
	"exclusions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"adequacy" text NOT NULL,
	"adequacy_reasons" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"license_expires_at" timestamp with time zone,
	"method_version" text NOT NULL,
	"invalidated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "campaign_recipients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"campaign_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"state" text DEFAULT 'snapshot' NOT NULL,
	"send_intent_id" uuid,
	"evaluated_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "campaigns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"segment_id" uuid,
	"content_hash" text,
	"subject" text,
	"body_text" text,
	"body_html" text,
	"segment_snapshot" jsonb,
	"eligible_count" integer,
	"status" text DEFAULT 'draft' NOT NULL,
	"approved_by" text,
	"approved_at" timestamp with time zone,
	"scheduled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contact_interests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"contact_id" uuid NOT NULL,
	"tag_key" text NOT NULL,
	"aggregate_confidence" integer NOT NULL,
	"status" text NOT NULL,
	"confirmed" boolean DEFAULT false NOT NULL,
	"user_override" text,
	"last_seen_at" timestamp with time zone NOT NULL,
	"rebuilt_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contact_preferences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"contact_id" uuid NOT NULL,
	"region" text,
	"timezone" text,
	"frequency" text,
	"must_attend_default" boolean,
	"wait_risk_tolerance" text,
	"split_group_allowed" boolean,
	"update_evidence" jsonb,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contact_preferences_contact_id_unique" UNIQUE("contact_id")
);
--> statement-breakpoint
CREATE TABLE "contacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email_original" text NOT NULL,
	"email_lookup" text NOT NULL,
	"country_confirmed" text,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_inbound_at" timestamp with time zone,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"contact_id" uuid NOT NULL,
	"subject" text,
	"revision" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"last_activity_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "deletion_ledger" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email_lookup_hash" text NOT NULL,
	"contact_id" uuid,
	"requested_at" timestamp with time zone NOT NULL,
	"verified_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"actor" text NOT NULL,
	"scope" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "entities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"aliases" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"league" text,
	"home_venue_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "entities_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "event_source_mappings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"source_id" text NOT NULL,
	"source_event_id" text,
	"authoritative_url" text,
	"role" text NOT NULL,
	"confidence" text DEFAULT 'unverified' NOT NULL,
	"verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"category" text NOT NULL,
	"subtype" text,
	"venue_id" uuid NOT NULL,
	"primary_entity_id" uuid,
	"opponent_entity_id" uuid,
	"is_home" boolean,
	"local_start_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'scheduled' NOT NULL,
	"verified_source_id" text,
	"is_fixture" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inbound_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"provider_event_id" text NOT NULL,
	"event_type" text NOT NULL,
	"payload_hash" text NOT NULL,
	"payload" jsonb NOT NULL,
	"signature_verified" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processing_state" text DEFAULT 'pending' NOT NULL,
	"processed_at" timestamp with time zone,
	"quarantine_reason" text
);
--> statement-breakpoint
CREATE TABLE "interest_observations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"contact_id" uuid NOT NULL,
	"tag_key" text NOT NULL,
	"message_id" uuid,
	"request_id" uuid,
	"explicit" boolean DEFAULT false NOT NULL,
	"polarity" text NOT NULL,
	"confidence" integer NOT NULL,
	"for_self" boolean,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "interest_taxonomy" (
	"key" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"canonical_entity_id" uuid,
	"allowed_for_marketing" boolean DEFAULT false NOT NULL,
	"description" text,
	"taxonomy_version" text DEFAULT '1' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kill_switches" (
	"key" text PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"reason" text,
	"changed_by" text,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "market_datasets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"license_reference" text,
	"approved_uses" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"coverage_note" text,
	"raw_retention_until" timestamp with time zone,
	"derived_retention_until" timestamp with time zone,
	"status" text DEFAULT 'quarantined' NOT NULL,
	"is_fixture" boolean DEFAULT false NOT NULL,
	"schema_version" text DEFAULT '1' NOT NULL,
	"approved_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "market_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"dataset_id" uuid,
	"event_id" uuid NOT NULL,
	"basket_key" text NOT NULL,
	"basket_version" integer DEFAULT 1 NOT NULL,
	"quantity" integer NOT NULL,
	"seat_zone" text,
	"observed_at" timestamp with time zone NOT NULL,
	"provider_as_of" timestamp with time zone,
	"lead_time_minutes" integer NOT NULL,
	"cheapest_eligible_total_cents" integer,
	"median_eligible_total_cents" integer,
	"eligible_option_count" integer,
	"source_ids" jsonb NOT NULL,
	"fee_basis" text NOT NULL,
	"coverage_complete" boolean NOT NULL,
	"quality_flags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"observation_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"method_version" text NOT NULL,
	"is_fixture" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "marketing_permissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"contact_id" uuid NOT NULL,
	"topic" text DEFAULT 'ticket_offers' NOT NULL,
	"status" text NOT NULL,
	"notice_version" text NOT NULL,
	"method" text NOT NULL,
	"evidence" jsonb NOT NULL,
	"granted_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "media_objects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_kind" text NOT NULL,
	"owner_id" uuid NOT NULL,
	"mime_type" text NOT NULL,
	"byte_length" integer NOT NULL,
	"sha256" text NOT NULL,
	"bytes" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	CONSTRAINT "media_len_pos" CHECK ("media_objects"."byte_length" >= 0)
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"direction" text NOT NULL,
	"provider" text NOT NULL,
	"provider_email_id" text,
	"rfc_message_id" text,
	"in_reply_to" text,
	"references_header" text,
	"from_address" text NOT NULL,
	"to_addresses" jsonb NOT NULL,
	"subject" text,
	"sanitized_text" text,
	"raw_media_id" uuid,
	"authentication_summary" jsonb,
	"auto_submitted" boolean DEFAULT false NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"purge_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "offer_observations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"offer_id" uuid NOT NULL,
	"run_id" uuid,
	"check_id" uuid,
	"event_id" uuid NOT NULL,
	"quantity" integer NOT NULL,
	"section" text,
	"row_label" text,
	"seat_numbers" jsonb,
	"seats_together" boolean,
	"admission_type" text DEFAULT 'reserved' NOT NULL,
	"base_total_cents" integer,
	"mandatory_fee_total_cents" integer,
	"tax_total_cents" integer,
	"delivery_total_cents" integer,
	"payable_total_cents" integer,
	"price_completeness" text NOT NULL,
	"restrictions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"delivery_method" text,
	"expected_delivery_at" timestamp with time zone,
	"availability" text DEFAULT 'unknown' NOT NULL,
	"verification_method" text NOT NULL,
	"verified_by" text,
	"source_as_of" timestamp with time zone,
	"fetched_at" timestamp with time zone NOT NULL,
	"retention_until" timestamp with time zone,
	"evidence" jsonb,
	CONSTRAINT "offer_obs_qty_pos" CHECK ("offer_observations"."quantity" > 0),
	CONSTRAINT "offer_obs_money_nonneg" CHECK (coalesce("offer_observations"."payable_total_cents",0) >= 0 and coalesce("offer_observations"."base_total_cents",0) >= 0)
);
--> statement-breakpoint
CREATE TABLE "offers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_id" text NOT NULL,
	"provider_listing_id" text,
	"event_id" uuid NOT NULL,
	"seller_name" text,
	"direct_purchase_url" text NOT NULL,
	"affiliate_url" text,
	"lifecycle" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "outbox_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_type" text NOT NULL,
	"event_key" text NOT NULL,
	"entity_id" text NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"payload" jsonb NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"lease_token" text,
	"lease_until" timestamp with time zone,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"dispatched_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "product_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_pseudonym" text,
	"contact_pseudonym" text,
	"event_name" text NOT NULL,
	"value" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recommendations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"draft_version" integer DEFAULT 1 NOT NULL,
	"draft_hash" text NOT NULL,
	"chosen_observation_ids" jsonb NOT NULL,
	"advice_run_id" uuid,
	"computed_savings_cents" integer,
	"body_text" text NOT NULL,
	"body_html" text NOT NULL,
	"subject" text NOT NULL,
	"review_status" text DEFAULT 'pending' NOT NULL,
	"reviewer_user_id" text,
	"review_note" text,
	"approved_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "request_transitions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_id" uuid NOT NULL,
	"from_state" text,
	"to_state" text NOT NULL,
	"revision" integer NOT NULL,
	"actor" text NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "request_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"brief" jsonb NOT NULL,
	"source_message_ids" jsonb NOT NULL,
	"unresolved_fields" jsonb NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"mode" text DEFAULT 'find_options' NOT NULL,
	"category" text,
	"state" text DEFAULT 'received' NOT NULL,
	"current_revision" integer DEFAULT 1 NOT NULL,
	"event_id" uuid,
	"deadline_at" timestamp with time zone,
	"owner_user_id" text,
	"country_confirmed" text,
	"failure_reason" text,
	"clarification_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "research_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"mode" text NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"budget_usd_micros" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"superseded_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "segments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"filter" jsonb NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "send_intents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"dedupe_key" text NOT NULL,
	"message_class" text NOT NULL,
	"contact_id" uuid,
	"conversation_id" uuid,
	"request_id" uuid,
	"request_revision" integer,
	"approval_id" uuid,
	"approved_hash" text,
	"recipient" text NOT NULL,
	"from_address" text NOT NULL,
	"subject" text NOT NULL,
	"body_text" text NOT NULL,
	"body_html" text NOT NULL,
	"headers" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"content_hash" text NOT NULL,
	"state" text DEFAULT 'queued' NOT NULL,
	"claim_token" text,
	"claimed_at" timestamp with time zone,
	"provider_message_id" text,
	"provider_rfc_message_id" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"submitted_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL,
	CONSTRAINT "session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "source_checks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"source_id" text NOT NULL,
	"ordinal" integer NOT NULL,
	"event_mapping_id" uuid,
	"status" text NOT NULL,
	"reason_code" text,
	"observed_at" timestamp with time zone NOT NULL,
	"source_as_of" timestamp with time zone,
	"result_count" integer DEFAULT 0 NOT NULL,
	"limitations" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"evidence" jsonb,
	"checked_by" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "source_registry" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"url" text NOT NULL,
	"group_name" text NOT NULL,
	"source_type" text NOT NULL,
	"categories" jsonb NOT NULL,
	"routing_tier" text NOT NULL,
	"routing_note" text NOT NULL,
	"evidence_url" text NOT NULL,
	"evidence_level" text NOT NULL,
	"research_date" text NOT NULL,
	"integration_status" text DEFAULT 'not_integrated' NOT NULL,
	"access_rights" text DEFAULT 'not_validated' NOT NULL,
	"us_event_only" boolean DEFAULT true NOT NULL,
	"vetting_status" text NOT NULL,
	"registry_version" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "suppressions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email_lookup" text NOT NULL,
	"scope" text NOT NULL,
	"reason" text NOT NULL,
	"provider" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trend_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"basket_key" text NOT NULL,
	"source_intersection" jsonb NOT NULL,
	"windows" jsonb NOT NULL,
	"baseline_snapshot_id" uuid,
	"current_snapshot_id" uuid,
	"direction" text NOT NULL,
	"adequacy" text NOT NULL,
	"quality_flags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"method_version" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "two_factor" (
	"id" text PRIMARY KEY NOT NULL,
	"secret" text NOT NULL,
	"backup_codes" text NOT NULL,
	"user_id" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "usage_ledger" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_id" uuid,
	"revision" integer,
	"run_id" uuid,
	"job_name" text,
	"model" text,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"tool_calls" integer DEFAULT 0 NOT NULL,
	"estimated_usd_micros" bigint NOT NULL,
	"actual_usd_micros" bigint,
	"price_table_version" text NOT NULL,
	"kind" text DEFAULT 'reservation' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"role" text DEFAULT 'reviewer' NOT NULL,
	"two_factor_enabled" boolean DEFAULT false,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "venue_seat_zones" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"venue_id" uuid NOT NULL,
	"layout_version" text NOT NULL,
	"section" text NOT NULL,
	"zone" text NOT NULL,
	"evidence" text,
	"reviewed_by" text,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "venues" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"aliases" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"city" text,
	"state" text,
	"country" text DEFAULT 'US' NOT NULL,
	"timezone" text NOT NULL,
	"layout_version" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "watch_alerts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"watch_id" uuid NOT NULL,
	"generation" integer NOT NULL,
	"observation_id" uuid NOT NULL,
	"dedupe_key" text NOT NULL,
	"payable_total_cents" integer NOT NULL,
	"approval_state" text DEFAULT 'pending' NOT NULL,
	"send_intent_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "watches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"contact_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"quantity" integer NOT NULL,
	"target_total_cents" integer NOT NULL,
	"acceptable_sections" jsonb,
	"together_required" boolean DEFAULT true NOT NULL,
	"consent_message_id" uuid,
	"cadence_minutes" integer NOT NULL,
	"next_check_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"state" text DEFAULT 'active' NOT NULL,
	"generation" integer DEFAULT 1 NOT NULL,
	"last_alert_at" timestamp with time zone,
	"lease_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "watches_qty_pos" CHECK ("watches"."quantity" > 0),
	CONSTRAINT "watches_target_nonneg" CHECK ("watches"."target_total_cents" >= 0)
);
--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "adapter_configs" ADD CONSTRAINT "adapter_configs_source_id_source_registry_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."source_registry"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "advice_outcomes" ADD CONSTRAINT "advice_outcomes_advice_run_id_advice_runs_id_fk" FOREIGN KEY ("advice_run_id") REFERENCES "public"."advice_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "advice_runs" ADD CONSTRAINT "advice_runs_request_id_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "advice_runs" ADD CONSTRAINT "advice_runs_benchmark_run_id_benchmark_runs_id_fk" FOREIGN KEY ("benchmark_run_id") REFERENCES "public"."benchmark_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "advice_runs" ADD CONSTRAINT "advice_runs_trend_run_id_trend_runs_id_fk" FOREIGN KEY ("trend_run_id") REFERENCES "public"."trend_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_media_id_media_objects_id_fk" FOREIGN KEY ("media_id") REFERENCES "public"."media_objects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "benchmark_runs" ADD CONSTRAINT "benchmark_runs_target_event_id_events_id_fk" FOREIGN KEY ("target_event_id") REFERENCES "public"."events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_recipients" ADD CONSTRAINT "campaign_recipients_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_recipients" ADD CONSTRAINT "campaign_recipients_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_segment_id_segments_id_fk" FOREIGN KEY ("segment_id") REFERENCES "public"."segments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_interests" ADD CONSTRAINT "contact_interests_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_interests" ADD CONSTRAINT "contact_interests_tag_key_interest_taxonomy_key_fk" FOREIGN KEY ("tag_key") REFERENCES "public"."interest_taxonomy"("key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_preferences" ADD CONSTRAINT "contact_preferences_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entities" ADD CONSTRAINT "entities_home_venue_id_venues_id_fk" FOREIGN KEY ("home_venue_id") REFERENCES "public"."venues"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_source_mappings" ADD CONSTRAINT "event_source_mappings_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_venue_id_venues_id_fk" FOREIGN KEY ("venue_id") REFERENCES "public"."venues"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_primary_entity_id_entities_id_fk" FOREIGN KEY ("primary_entity_id") REFERENCES "public"."entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_opponent_entity_id_entities_id_fk" FOREIGN KEY ("opponent_entity_id") REFERENCES "public"."entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interest_observations" ADD CONSTRAINT "interest_observations_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interest_observations" ADD CONSTRAINT "interest_observations_tag_key_interest_taxonomy_key_fk" FOREIGN KEY ("tag_key") REFERENCES "public"."interest_taxonomy"("key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interest_observations" ADD CONSTRAINT "interest_observations_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interest_observations" ADD CONSTRAINT "interest_observations_request_id_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interest_taxonomy" ADD CONSTRAINT "interest_taxonomy_canonical_entity_id_entities_id_fk" FOREIGN KEY ("canonical_entity_id") REFERENCES "public"."entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_snapshots" ADD CONSTRAINT "market_snapshots_dataset_id_market_datasets_id_fk" FOREIGN KEY ("dataset_id") REFERENCES "public"."market_datasets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_snapshots" ADD CONSTRAINT "market_snapshots_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marketing_permissions" ADD CONSTRAINT "marketing_permissions_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offer_observations" ADD CONSTRAINT "offer_observations_offer_id_offers_id_fk" FOREIGN KEY ("offer_id") REFERENCES "public"."offers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offer_observations" ADD CONSTRAINT "offer_observations_run_id_research_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."research_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offer_observations" ADD CONSTRAINT "offer_observations_check_id_source_checks_id_fk" FOREIGN KEY ("check_id") REFERENCES "public"."source_checks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offer_observations" ADD CONSTRAINT "offer_observations_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offers" ADD CONSTRAINT "offers_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recommendations" ADD CONSTRAINT "recommendations_request_id_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "request_transitions" ADD CONSTRAINT "request_transitions_request_id_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "request_versions" ADD CONSTRAINT "request_versions_request_id_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requests" ADD CONSTRAINT "requests_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requests" ADD CONSTRAINT "requests_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_runs" ADD CONSTRAINT "research_runs_request_id_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "send_intents" ADD CONSTRAINT "send_intents_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "send_intents" ADD CONSTRAINT "send_intents_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_checks" ADD CONSTRAINT "source_checks_run_id_research_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."research_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trend_runs" ADD CONSTRAINT "trend_runs_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "two_factor" ADD CONSTRAINT "two_factor_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "venue_seat_zones" ADD CONSTRAINT "venue_seat_zones_venue_id_venues_id_fk" FOREIGN KEY ("venue_id") REFERENCES "public"."venues"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "watch_alerts" ADD CONSTRAINT "watch_alerts_watch_id_watches_id_fk" FOREIGN KEY ("watch_id") REFERENCES "public"."watches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "watch_alerts" ADD CONSTRAINT "watch_alerts_observation_id_offer_observations_id_fk" FOREIGN KEY ("observation_id") REFERENCES "public"."offer_observations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "watches" ADD CONSTRAINT "watches_request_id_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "watches" ADD CONSTRAINT "watches_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "watches" ADD CONSTRAINT "watches_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "watches" ADD CONSTRAINT "watches_consent_message_id_messages_id_fk" FOREIGN KEY ("consent_message_id") REFERENCES "public"."messages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_user_idx" ON "account" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "advice_runs_request_idx" ON "advice_runs" USING btree ("request_id","revision");--> statement-breakpoint
CREATE INDEX "attachments_message_idx" ON "attachments" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "audit_entity_idx" ON "audit_log" USING btree ("entity_kind","entity_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "campaign_recipients_uq" ON "campaign_recipients" USING btree ("campaign_id","contact_id");--> statement-breakpoint
CREATE UNIQUE INDEX "contact_interests_uq" ON "contact_interests" USING btree ("contact_id","tag_key");--> statement-breakpoint
CREATE INDEX "contact_interests_tag_idx" ON "contact_interests" USING btree ("tag_key","status","last_seen_at");--> statement-breakpoint
CREATE UNIQUE INDEX "contacts_email_lookup_uq" ON "contacts" USING btree ("email_lookup");--> statement-breakpoint
CREATE INDEX "conversations_contact_idx" ON "conversations" USING btree ("contact_id","last_activity_at");--> statement-breakpoint
CREATE UNIQUE INDEX "event_source_mappings_uq" ON "event_source_mappings" USING btree ("source_id","source_event_id");--> statement-breakpoint
CREATE INDEX "events_venue_start_idx" ON "events" USING btree ("venue_id","local_start_at");--> statement-breakpoint
CREATE INDEX "events_entity_idx" ON "events" USING btree ("primary_entity_id");--> statement-breakpoint
CREATE UNIQUE INDEX "inbound_events_provider_uq" ON "inbound_events" USING btree ("provider","provider_event_id");--> statement-breakpoint
CREATE INDEX "interest_obs_contact_idx" ON "interest_observations" USING btree ("contact_id","tag_key","observed_at");--> statement-breakpoint
CREATE INDEX "market_snapshots_event_basket_time_idx" ON "market_snapshots" USING btree ("event_id","basket_key","observed_at");--> statement-breakpoint
CREATE INDEX "marketing_permissions_contact_idx" ON "marketing_permissions" USING btree ("contact_id","topic","created_at");--> statement-breakpoint
CREATE INDEX "media_owner_idx" ON "media_objects" USING btree ("owner_kind","owner_id");--> statement-breakpoint
CREATE UNIQUE INDEX "messages_provider_email_uq" ON "messages" USING btree ("provider","direction","provider_email_id");--> statement-breakpoint
CREATE INDEX "messages_rfc_idx" ON "messages" USING btree ("rfc_message_id");--> statement-breakpoint
CREATE INDEX "messages_conversation_idx" ON "messages" USING btree ("conversation_id","received_at");--> statement-breakpoint
CREATE INDEX "offer_obs_event_qty_time_idx" ON "offer_observations" USING btree ("event_id","quantity","fetched_at");--> statement-breakpoint
CREATE INDEX "offers_event_idx" ON "offers" USING btree ("event_id","source_id");--> statement-breakpoint
CREATE UNIQUE INDEX "outbox_event_key_uq" ON "outbox_events" USING btree ("event_key");--> statement-breakpoint
CREATE INDEX "outbox_state_next_idx" ON "outbox_events" USING btree ("state","next_attempt_at");--> statement-breakpoint
CREATE INDEX "product_events_name_idx" ON "product_events" USING btree ("event_name","created_at");--> statement-breakpoint
CREATE INDEX "recommendations_request_idx" ON "recommendations" USING btree ("request_id","revision");--> statement-breakpoint
CREATE INDEX "request_transitions_request_idx" ON "request_transitions" USING btree ("request_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "request_versions_uq" ON "request_versions" USING btree ("request_id","revision");--> statement-breakpoint
CREATE INDEX "requests_state_deadline_idx" ON "requests" USING btree ("state","deadline_at");--> statement-breakpoint
CREATE INDEX "requests_contact_idx" ON "requests" USING btree ("contact_id");--> statement-breakpoint
CREATE INDEX "research_runs_request_idx" ON "research_runs" USING btree ("request_id","revision");--> statement-breakpoint
CREATE UNIQUE INDEX "send_intents_dedupe_uq" ON "send_intents" USING btree ("dedupe_key");--> statement-breakpoint
CREATE INDEX "send_intents_provider_idx" ON "send_intents" USING btree ("provider_message_id");--> statement-breakpoint
CREATE INDEX "send_intents_state_idx" ON "send_intents" USING btree ("state","created_at");--> statement-breakpoint
CREATE INDEX "session_user_idx" ON "session" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "source_checks_uq" ON "source_checks" USING btree ("run_id","source_id","ordinal");--> statement-breakpoint
CREATE UNIQUE INDEX "suppressions_uq" ON "suppressions" USING btree ("email_lookup","scope");--> statement-breakpoint
CREATE INDEX "two_factor_user_idx" ON "two_factor" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "usage_request_idx" ON "usage_ledger" USING btree ("request_id","revision");--> statement-breakpoint
CREATE INDEX "usage_day_idx" ON "usage_ledger" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "venue_seat_zones_uq" ON "venue_seat_zones" USING btree ("venue_id","layout_version","section");--> statement-breakpoint
CREATE INDEX "verification_identifier_idx" ON "verification" USING btree ("identifier");--> statement-breakpoint
CREATE UNIQUE INDEX "watch_alerts_dedupe_uq" ON "watch_alerts" USING btree ("dedupe_key");--> statement-breakpoint
CREATE INDEX "watch_alerts_watch_idx" ON "watch_alerts" USING btree ("watch_id","created_at");--> statement-breakpoint
CREATE INDEX "watches_state_next_idx" ON "watches" USING btree ("state","next_check_at");