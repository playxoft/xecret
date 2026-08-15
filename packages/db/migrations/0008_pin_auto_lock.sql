-- Idle auto-lock for the dashboard.
--
-- Minutes of idleness before the client locks itself and asks for the PIN
-- again; 0 means never. A property of the PIN protection, so it lives on
-- user_pins — meaningless without a PIN to ask for. The default of 10 applies
-- to every existing row: locking people who never chose is the safe direction,
-- and the setting is one visit to the security page to change.
--
-- The CHECK restates the fixed menu the client offers
-- (AUTO_LOCK_MINUTES_OPTIONS in @xecret/core/auth), so a row cannot hold an
-- interval no settings screen can display or repair.
--
-- Additive only; nothing dropped, nothing rewritten.

ALTER TABLE user_pins ADD COLUMN IF NOT EXISTS auto_lock_minutes integer NOT NULL DEFAULT 10;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'user_pins_auto_lock_check'
  ) THEN
    ALTER TABLE user_pins
      ADD CONSTRAINT user_pins_auto_lock_check
      CHECK (auto_lock_minutes in (0, 5, 10, 20, 30, 45, 60));
  END IF;
END $$;
