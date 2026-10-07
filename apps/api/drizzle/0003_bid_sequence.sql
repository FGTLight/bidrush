ALTER TABLE "bids" ADD COLUMN "seq" integer NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "bids_auction_seq_key" ON "bids" USING btree ("auction_id","seq");