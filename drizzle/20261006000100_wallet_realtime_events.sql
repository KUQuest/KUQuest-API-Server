CREATE FUNCTION notify_wallet_activity_update() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM pg_notify(
    'kuquest_wallet_updates',
    json_build_object('memberId', NEW.user_id, 'type', 'WALLET_UPDATED')::text
  );
  RETURN NEW;
END;
$$;

CREATE TRIGGER wallet_activities_realtime_update
AFTER INSERT ON wallet_activities
FOR EACH ROW EXECUTE FUNCTION notify_wallet_activity_update();

CREATE FUNCTION notify_wallet_status_update() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  member_id uuid;
BEGIN
  SELECT user_id INTO member_id
  FROM wallet_wallets
  WHERE id = NEW.wallet_id;

  IF member_id IS NOT NULL THEN
    PERFORM pg_notify(
      'kuquest_wallet_updates',
      json_build_object('memberId', member_id, 'type', 'WALLET_UPDATED')::text
    );
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER wallet_status_history_realtime_update
AFTER INSERT ON wallet_status_history
FOR EACH ROW EXECUTE FUNCTION notify_wallet_status_update();

CREATE FUNCTION notify_top_up_status_update() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  member_id uuid;
BEGIN
  SELECT user_id INTO member_id
  FROM payment_top_ups
  WHERE id = NEW.top_up_id;

  IF member_id IS NOT NULL THEN
    PERFORM pg_notify(
      'kuquest_wallet_updates',
      json_build_object(
        'memberId', member_id,
        'type', 'TOP_UP_UPDATED',
        'topUpId', NEW.top_up_id
      )::text
    );
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER payment_top_up_status_realtime_update
AFTER INSERT ON payment_top_up_status_history
FOR EACH ROW EXECUTE FUNCTION notify_top_up_status_update();
