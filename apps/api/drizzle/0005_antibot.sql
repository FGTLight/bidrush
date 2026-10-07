CREATE TYPE "public"."risk_level" AS ENUM('allow', 'throttle', 'challenge', 'block');--> statement-breakpoint
CREATE TABLE "risk_events" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "risk_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"user_id" uuid NOT NULL,
	"auction_id" uuid,
	"bid_id" uuid,
	"score" double precision NOT NULL,
	"level" "risk_level" NOT NULL,
	"signals" jsonb NOT NULL,
	"ip" text,
	"fingerprint" text,
	"auto_blocked" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "risk_events_score_range" CHECK ("risk_events"."score" >= 0 and "risk_events"."score" <= 1)
);
--> statement-breakpoint
CREATE TABLE "user_risk" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"score" double precision NOT NULL,
	"level" "risk_level" NOT NULL,
	"top_reasons" text[] NOT NULL,
	"last_event_at" timestamp with time zone NOT NULL,
	"cleared_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "risk_events" ADD CONSTRAINT "risk_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "risk_events" ADD CONSTRAINT "risk_events_auction_id_auctions_id_fk" FOREIGN KEY ("auction_id") REFERENCES "public"."auctions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_risk" ADD CONSTRAINT "user_risk_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "risk_events_user_created_idx" ON "risk_events" USING btree ("user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "risk_events_created_idx" ON "risk_events" USING btree ("created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "user_risk_score_idx" ON "user_risk" USING btree ("score" DESC NULLS LAST);