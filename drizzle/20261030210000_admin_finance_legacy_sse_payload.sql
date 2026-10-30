CREATE OR REPLACE FUNCTION notify_admin_finance_resource_update() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  resource_type text;
BEGIN
  IF TG_TABLE_NAME = 'wallet_wallets' THEN
    resource_type := 'WALLET';
  ELSIF TG_TABLE_NAME = 'payment_payouts' THEN
    resource_type := 'PAYOUT';
  ELSIF TG_TABLE_NAME = 'payment_top_ups' THEN
    resource_type := 'TOP_UP';
  ELSE
    RAISE EXCEPTION 'Unsupported Admin finance update table: %', TG_TABLE_NAME;
  END IF;

  PERFORM pg_notify(
    'kuquest_admin_updates',
    jsonb_build_object(
      'type', 'RESOURCE_UPDATED',
      'subjectType', resource_type,
      'subjectId', NEW.id
    )::text
  );

  IF TG_TABLE_NAME = 'wallet_wallets' THEN
    PERFORM pg_notify(
      'kuquest_admin_updates',
      jsonb_build_object(
        'type', 'RESOURCE_UPDATED',
        'subjectType', 'MEMBER',
        'subjectId', NEW.user_id
      )::text
    );
  END IF;

  RETURN NEW;
END;
$$;
