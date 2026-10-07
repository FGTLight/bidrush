-- Ledger invariants enforced by Postgres (hand-written migration).
--
-- 1. Balances are derived from entries: inserting an entry updates the
--    account's cached balance in the same statement. The CHECK on
--    ledger_accounts.balance then rejects any entry that would overdraw a
--    user account, whatever code path inserted it.
-- 2. Every transaction balances: its entries sum to zero. Checked at COMMIT
--    (deferred), once all of its entries exist.
-- 3. The ledger is append-only: entries and transactions can't be updated
--    or deleted. Corrections are new, reversing transactions.
-- 4. The cached balance can only be changed by the entry trigger, so it can
--    never drift from the sum of the entries.

CREATE FUNCTION ledger_apply_entry() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE ledger_accounts SET balance = balance + NEW.amount WHERE id = NEW.account_id;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER ledger_entries_apply
  AFTER INSERT ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION ledger_apply_entry();
--> statement-breakpoint

CREATE FUNCTION ledger_check_balanced() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  total bigint;
BEGIN
  SELECT coalesce(sum(amount), 0) INTO total
  FROM ledger_entries WHERE transaction_id = NEW.transaction_id;
  IF total <> 0 THEN
    RAISE EXCEPTION 'ledger transaction % is unbalanced (sum %)', NEW.transaction_id, total
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER ledger_entries_balanced
  AFTER INSERT ON ledger_entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION ledger_check_balanced();
--> statement-breakpoint

CREATE FUNCTION ledger_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = 'restrict_violation';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER ledger_entries_append_only
  BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION ledger_append_only();
--> statement-breakpoint
CREATE TRIGGER ledger_transactions_append_only
  BEFORE UPDATE OR DELETE ON ledger_transactions
  FOR EACH ROW EXECUTE FUNCTION ledger_append_only();
--> statement-breakpoint

CREATE FUNCTION ledger_balance_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- This trigger runs at depth 1 for a direct UPDATE, and at depth 2 when
  -- the UPDATE comes from ledger_apply_entry (itself a trigger).
  IF pg_trigger_depth() < 2 THEN
    RAISE EXCEPTION 'ledger balances change only through ledger_entries'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER ledger_accounts_balance_guard
  BEFORE UPDATE OF balance ON ledger_accounts
  FOR EACH ROW EXECUTE FUNCTION ledger_balance_guard();
--> statement-breakpoint

-- The two system accounts.
INSERT INTO ledger_accounts (kind) VALUES ('issuance'), ('revenue');
