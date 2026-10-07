-- Soft-close rule, used inside the bid engine's atomic UPDATE.
--
-- A bid accepted within `window_ms` of the end pushes the end back by
-- `extension_ms`, without exceeding `max_extension_ms` in total.
-- Mirrored by softCloseExtensionMs() in src/bids/rules.ts (unit-tested).

CREATE FUNCTION soft_close_extension_ms(
  ends_at timestamptz,
  at timestamptz,
  window_ms integer,
  extension_ms integer,
  max_extension_ms integer,
  extended_ms integer
) RETURNS integer
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE
    WHEN ends_at - at <= window_ms * interval '1 millisecond'
      THEN greatest(0, least(extension_ms, max_extension_ms - extended_ms))
    ELSE 0
  END
$$;
