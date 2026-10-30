CREATE OR REPLACE FUNCTION notify_admin_finance_resource_update() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  resource_type text;
  member_subject jsonb;
  related_subjects jsonb;
  wallet_id uuid;
BEGIN
  member_subject := jsonb_build_object('subjectType', 'MEMBER', 'subjectId', NEW.user_id);
  related_subjects := jsonb_build_array(member_subject);

  IF TG_TABLE_NAME = 'wallet_wallets' THEN
    resource_type := 'WALLET';
  ELSE
    IF TG_TABLE_NAME = 'payment_payouts' THEN
      resource_type := 'PAYOUT';
    ELSIF TG_TABLE_NAME = 'payment_top_ups' THEN
      resource_type := 'TOP_UP';
    ELSE
      RAISE EXCEPTION 'Unsupported Admin finance update table: %', TG_TABLE_NAME;
    END IF;

    SELECT id INTO wallet_id
    FROM wallet_wallets
    WHERE user_id = NEW.user_id;

    IF wallet_id IS NOT NULL THEN
      related_subjects := related_subjects || jsonb_build_array(
        jsonb_build_object('subjectType', 'WALLET', 'subjectId', wallet_id)
      );
    END IF;
  END IF;

  PERFORM pg_notify(
    'kuquest_admin_updates',
    jsonb_build_object(
      'type', 'RESOURCE_UPDATED',
      'subjectType', resource_type,
      'subjectId', NEW.id,
      'relatedSubjects', related_subjects
    )::text
  );

  IF TG_TABLE_NAME = 'wallet_wallets' THEN
    PERFORM pg_notify(
      'kuquest_admin_updates',
      (jsonb_build_object('type', 'RESOURCE_UPDATED') || member_subject)::text
    );
  END IF;

  RETURN NEW;
END;
$$;
