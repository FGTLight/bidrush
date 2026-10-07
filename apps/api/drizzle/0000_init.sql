CREATE TYPE "public"."auction_status" AS ENUM('scheduled', 'live', 'ended', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."ledger_account_kind" AS ENUM('available', 'reserved', 'issuance', 'revenue');--> statement-breakpoint
CREATE TYPE "public"."ledger_tx_kind" AS ENUM('grant', 'reserve', 'release', 'settle');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('user', 'admin');--> statement-breakpoint
CREATE TABLE "auction_participants" (
	"auction_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"highest_bid" integer NOT NULL,
	"last_bid_at" timestamp with time zone NOT NULL,
	CONSTRAINT "auction_participants_auction_id_user_id_pk" PRIMARY KEY("auction_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "auctions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"image_url" text,
	"status" "auction_status" DEFAULT 'scheduled' NOT NULL,
	"starting_price" integer NOT NULL,
	"min_increment" integer NOT NULL,
	"current_price" integer NOT NULL,
	"leader_id" uuid,
	"leading_bid_id" uuid,
	"bid_count" integer DEFAULT 0 NOT NULL,
	"bidder_count" integer DEFAULT 0 NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"soft_close_window_ms" integer NOT NULL,
	"extension_ms" integer NOT NULL,
	"max_extension_ms" integer NOT NULL,
	"extended_ms" integer DEFAULT 0 NOT NULL,
	"ended_at" timestamp with time zone,
	"settled_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "auctions_starting_price_nonneg" CHECK ("auctions"."starting_price" >= 0),
	CONSTRAINT "auctions_min_increment_positive" CHECK ("auctions"."min_increment" > 0),
	CONSTRAINT "auctions_price_not_below_start" CHECK ("auctions"."current_price" >= "auctions"."starting_price"),
	CONSTRAINT "auctions_ends_after_start" CHECK ("auctions"."ends_at" > "auctions"."starts_at"),
	CONSTRAINT "auctions_extension_within_max" CHECK ("auctions"."extended_ms" >= 0 and "auctions"."extended_ms" <= "auctions"."max_extension_ms"),
	CONSTRAINT "auctions_counts_nonneg" CHECK ("auctions"."bid_count" >= 0 and "auctions"."bidder_count" >= 0),
	CONSTRAINT "auctions_leader_has_bid" CHECK (("auctions"."leader_id" is null) = ("auctions"."leading_bid_id" is null))
);
--> statement-breakpoint
CREATE TABLE "bids" (
	"id" uuid PRIMARY KEY NOT NULL,
	"auction_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"amount" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "bids_amount_positive" CHECK ("bids"."amount" > 0)
);
--> statement-breakpoint
CREATE TABLE "ledger_accounts" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "ledger_accounts_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"user_id" uuid,
	"kind" "ledger_account_kind" NOT NULL,
	"balance" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "ledger_accounts_user_kind_key" UNIQUE NULLS NOT DISTINCT("user_id","kind"),
	CONSTRAINT "ledger_accounts_owner_matches_kind" CHECK (("ledger_accounts"."kind" in ('issuance', 'revenue')) = ("ledger_accounts"."user_id" is null)),
	CONSTRAINT "ledger_accounts_balance_nonneg" CHECK ("ledger_accounts"."kind" = 'issuance' or "ledger_accounts"."balance" >= 0)
);
--> statement-breakpoint
CREATE TABLE "ledger_entries" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "ledger_entries_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"transaction_id" bigint NOT NULL,
	"account_id" integer NOT NULL,
	"amount" bigint NOT NULL,
	CONSTRAINT "ledger_entries_amount_nonzero" CHECK ("ledger_entries"."amount" <> 0)
);
--> statement-breakpoint
CREATE TABLE "ledger_transactions" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "ledger_transactions_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"kind" "ledger_tx_kind" NOT NULL,
	"auction_id" uuid,
	"bid_id" uuid,
	"memo" text,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "ledger_tx_refs" CHECK ("ledger_transactions"."kind" = 'grant' or ("ledger_transactions"."auction_id" is not null and ("ledger_transactions"."kind" = 'settle' or "ledger_transactions"."bid_id" is not null)))
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"display_name" text NOT NULL,
	"role" "user_role" DEFAULT 'user' NOT NULL,
	"blocked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_key" UNIQUE("email"),
	CONSTRAINT "users_email_lowercase" CHECK ("users"."email" = lower("users"."email"))
);
--> statement-breakpoint
ALTER TABLE "auction_participants" ADD CONSTRAINT "auction_participants_auction_id_auctions_id_fk" FOREIGN KEY ("auction_id") REFERENCES "public"."auctions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auction_participants" ADD CONSTRAINT "auction_participants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auctions" ADD CONSTRAINT "auctions_leader_id_users_id_fk" FOREIGN KEY ("leader_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auctions" ADD CONSTRAINT "auctions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bids" ADD CONSTRAINT "bids_auction_id_auctions_id_fk" FOREIGN KEY ("auction_id") REFERENCES "public"."auctions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bids" ADD CONSTRAINT "bids_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_accounts" ADD CONSTRAINT "ledger_accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_transaction_id_ledger_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."ledger_transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_account_id_ledger_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."ledger_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_transactions" ADD CONSTRAINT "ledger_transactions_auction_id_auctions_id_fk" FOREIGN KEY ("auction_id") REFERENCES "public"."auctions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "auction_participants_user_idx" ON "auction_participants" USING btree ("user_id","last_bid_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "auctions_status_starts_at_idx" ON "auctions" USING btree ("status","starts_at");--> statement-breakpoint
CREATE INDEX "auctions_status_ends_at_idx" ON "auctions" USING btree ("status","ends_at");--> statement-breakpoint
CREATE UNIQUE INDEX "bids_auction_amount_key" ON "bids" USING btree ("auction_id","amount");--> statement-breakpoint
CREATE INDEX "bids_auction_created_idx" ON "bids" USING btree ("auction_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "bids_user_created_idx" ON "bids" USING btree ("user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "ledger_entries_tx_idx" ON "ledger_entries" USING btree ("transaction_id");--> statement-breakpoint
CREATE INDEX "ledger_entries_account_idx" ON "ledger_entries" USING btree ("account_id","id" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_tx_reserve_once" ON "ledger_transactions" USING btree ("bid_id") WHERE "ledger_transactions"."kind" = 'reserve';--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_tx_release_once" ON "ledger_transactions" USING btree ("bid_id") WHERE "ledger_transactions"."kind" = 'release';--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_tx_settle_once" ON "ledger_transactions" USING btree ("auction_id") WHERE "ledger_transactions"."kind" = 'settle';