LOCK TABLE clients, authorizations, vendors, fees, invoices, payments, remittances, remittance_allocations IN SHARE ROW EXCLUSIVE MODE;--> statement-breakpoint
DO $$
DECLARE
  invalid_link text;
BEGIN
  SELECT format('%s %s -> %s %s', child_table, child_id, parent_table, parent_id)
  INTO invalid_link
  FROM (
    SELECT 'authorizations' child_table, a.id child_id, 'clients' parent_table, a.client_id parent_id
    FROM authorizations a JOIN clients c ON c.id = a.client_id
    WHERE a.is_deleted = false AND c.is_deleted = true
    UNION ALL
    SELECT 'fees', f.id, 'clients', f.client_id
    FROM fees f JOIN clients c ON c.id = f.client_id
    WHERE f.is_deleted = false AND c.is_deleted = true
    UNION ALL
    SELECT 'fees', f.id, 'authorizations', f.authorization_id
    FROM fees f JOIN authorizations a ON a.id = f.authorization_id
    WHERE f.is_deleted = false AND (a.is_deleted = true OR a.client_id <> f.client_id)
    UNION ALL
    SELECT 'fees', f.id, 'payments', f.payment_id
    FROM fees f JOIN payments p ON p.id = f.payment_id
    WHERE f.is_deleted = false AND (p.is_deleted = true OR p.client_id <> f.client_id)
    UNION ALL
    SELECT 'invoices', i.id, 'clients', i.client_id
    FROM invoices i JOIN clients c ON c.id = i.client_id
    WHERE i.is_deleted = false AND c.is_deleted = true
    UNION ALL
    SELECT 'invoices', i.id, 'authorizations', i.authorization_id
    FROM invoices i JOIN authorizations a ON a.id = i.authorization_id
    WHERE i.is_deleted = false AND (a.is_deleted = true OR a.client_id <> i.client_id)
    UNION ALL
    SELECT 'payments', p.id, 'clients', p.client_id
    FROM payments p JOIN clients c ON c.id = p.client_id
    WHERE p.is_deleted = false AND c.is_deleted = true
    UNION ALL
    SELECT 'payments', p.id, 'authorizations', p.authorization_id
    FROM payments p JOIN authorizations a ON a.id = p.authorization_id
    WHERE p.is_deleted = false AND (a.is_deleted = true OR a.client_id <> p.client_id)
    UNION ALL
    SELECT 'payments', p.id, 'invoices', p.invoice_id
    FROM payments p JOIN invoices i ON i.id = p.invoice_id
    WHERE p.is_deleted = false AND (i.is_deleted = true OR i.client_id <> p.client_id)
    UNION ALL
    SELECT 'remittances', r.id, 'clients', r.client_id
    FROM remittances r JOIN clients c ON c.id = r.client_id
    WHERE r.is_deleted = false AND c.is_deleted = true
    UNION ALL
    SELECT 'remittances', r.id, 'authorizations', r.authorization_id
    FROM remittances r JOIN authorizations a ON a.id = r.authorization_id
    WHERE r.is_deleted = false AND (a.is_deleted = true OR a.client_id <> r.client_id)
    UNION ALL
    SELECT 'remittances', r.id, 'payments', r.matched_payment_id
    FROM remittances r JOIN payments p ON p.id = r.matched_payment_id
    WHERE r.is_deleted = false AND (
      p.is_deleted = true
      OR p.client_id <> r.client_id
      OR (r.authorization_id IS NOT NULL AND p.authorization_id IS DISTINCT FROM r.authorization_id)
    )
    UNION ALL
    SELECT 'remittance_allocations', ra.id, 'remittances', ra.remittance_id
    FROM remittance_allocations ra
    JOIN remittances r ON r.id = ra.remittance_id
    JOIN payments p ON p.id = ra.payment_id
    WHERE r.is_deleted = true
      OR p.is_deleted = true
      OR p.client_id <> r.client_id
      OR (r.authorization_id IS NOT NULL AND p.authorization_id IS DISTINCT FROM r.authorization_id)
  ) invalid
  LIMIT 1;

  IF invalid_link IS NOT NULL THEN
    RAISE EXCEPTION 'cannot install financial link guards: active link references deleted parent: %', invalid_link;
  END IF;
END;
$$;--> statement-breakpoint

CREATE FUNCTION enforce_client_soft_delete_financial_links()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.is_deleted = true AND OLD.is_deleted = false AND EXISTS (
    SELECT 1 FROM authorizations WHERE client_id = OLD.id AND is_deleted = false
    UNION ALL
    SELECT 1 FROM fees WHERE client_id = OLD.id AND is_deleted = false
    UNION ALL
    SELECT 1 FROM invoices WHERE client_id = OLD.id AND is_deleted = false
    UNION ALL
    SELECT 1 FROM payments WHERE client_id = OLD.id AND is_deleted = false
    UNION ALL
    SELECT 1 FROM remittances WHERE client_id = OLD.id AND is_deleted = false
  ) THEN
    RAISE EXCEPTION 'Client cannot be deleted while active financial records reference them'
      USING ERRCODE = '23503',
            CONSTRAINT = 'clients_active_financial_links';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER clients_financial_soft_delete_guard
BEFORE UPDATE OF is_deleted
ON clients
FOR EACH ROW
EXECUTE FUNCTION enforce_client_soft_delete_financial_links();--> statement-breakpoint

CREATE FUNCTION enforce_authorization_soft_delete_financial_links()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.is_deleted = true AND OLD.is_deleted = false AND EXISTS (
    SELECT 1 FROM fees WHERE authorization_id = OLD.id AND is_deleted = false
    UNION ALL
    SELECT 1 FROM invoices WHERE authorization_id = OLD.id AND is_deleted = false
    UNION ALL
    SELECT 1 FROM payments WHERE authorization_id = OLD.id AND is_deleted = false
    UNION ALL
    SELECT 1 FROM remittances WHERE authorization_id = OLD.id AND is_deleted = false
  ) THEN
    RAISE EXCEPTION 'Authorization cannot be deleted while active financial records reference it'
      USING ERRCODE = '23503',
            CONSTRAINT = 'authorizations_active_financial_links';
  END IF;

  IF NEW.client_id IS DISTINCT FROM OLD.client_id AND EXISTS (
    SELECT 1 FROM fees WHERE authorization_id = OLD.id AND is_deleted = false AND client_id <> NEW.client_id
    UNION ALL
    SELECT 1 FROM invoices WHERE authorization_id = OLD.id AND is_deleted = false AND client_id <> NEW.client_id
    UNION ALL
    SELECT 1 FROM payments WHERE authorization_id = OLD.id AND is_deleted = false AND client_id <> NEW.client_id
    UNION ALL
    SELECT 1 FROM remittances WHERE authorization_id = OLD.id AND is_deleted = false AND client_id <> NEW.client_id
  ) THEN
    RAISE EXCEPTION 'Authorization client cannot change while active financial records reference it'
      USING ERRCODE = '23503',
            CONSTRAINT = 'authorizations_active_financial_links';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER authorizations_financial_soft_delete_guard
BEFORE UPDATE OF is_deleted, client_id
ON authorizations
FOR EACH ROW
EXECUTE FUNCTION enforce_authorization_soft_delete_financial_links();--> statement-breakpoint

CREATE FUNCTION enforce_invoice_soft_delete_financial_links()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.is_deleted = true AND OLD.is_deleted = false AND EXISTS (
    SELECT 1 FROM payments WHERE invoice_id = OLD.id AND is_deleted = false
  ) THEN
    RAISE EXCEPTION 'Invoice cannot be deleted while active payments reference it'
      USING ERRCODE = '23503',
            CONSTRAINT = 'invoices_active_payment_links';
  END IF;

  IF NEW.client_id IS DISTINCT FROM OLD.client_id AND EXISTS (
    SELECT 1 FROM payments
    WHERE invoice_id = OLD.id AND is_deleted = false AND client_id <> NEW.client_id
  ) THEN
    RAISE EXCEPTION 'Invoice client cannot change while active payments reference it'
      USING ERRCODE = '23503',
            CONSTRAINT = 'invoices_active_payment_links';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER invoices_financial_soft_delete_guard
BEFORE UPDATE OF is_deleted, client_id
ON invoices
FOR EACH ROW
EXECUTE FUNCTION enforce_invoice_soft_delete_financial_links();--> statement-breakpoint

CREATE FUNCTION enforce_payment_soft_delete_financial_links()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.is_deleted = true AND OLD.is_deleted = false AND EXISTS (
    SELECT 1 FROM remittances WHERE matched_payment_id = OLD.id AND is_deleted = false
    UNION ALL
    SELECT 1 FROM remittance_allocations WHERE payment_id = OLD.id
  ) THEN
    RAISE EXCEPTION 'Payment cannot be deleted while active financial records reference it'
      USING ERRCODE = '23503',
            CONSTRAINT = 'payments_active_financial_links';
  END IF;

  IF (
    NEW.client_id IS DISTINCT FROM OLD.client_id
    OR NEW.authorization_id IS DISTINCT FROM OLD.authorization_id
  ) AND EXISTS (
    SELECT 1
    FROM remittances
    WHERE matched_payment_id = OLD.id
      AND is_deleted = false
      AND (
        client_id <> NEW.client_id
        OR (authorization_id IS NOT NULL AND authorization_id IS DISTINCT FROM NEW.authorization_id)
      )
    UNION ALL
    SELECT 1
    FROM remittance_allocations ra
    JOIN remittances r ON r.id = ra.remittance_id
    WHERE ra.payment_id = OLD.id
      AND (
        r.is_deleted = true
        OR r.client_id <> NEW.client_id
        OR (r.authorization_id IS NOT NULL AND r.authorization_id IS DISTINCT FROM NEW.authorization_id)
      )
    UNION ALL
    SELECT 1
    FROM fees
    WHERE payment_id = OLD.id
      AND is_deleted = false
      AND client_id <> NEW.client_id
  ) THEN
    RAISE EXCEPTION 'Payment client or authorization cannot change while linked financial records would become invalid'
      USING ERRCODE = '23503',
            CONSTRAINT = 'payments_active_financial_links';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER payments_financial_soft_delete_guard
BEFORE UPDATE OF is_deleted, client_id, authorization_id
ON payments
FOR EACH ROW
EXECUTE FUNCTION enforce_payment_soft_delete_financial_links();--> statement-breakpoint

CREATE FUNCTION enforce_remittance_allocation_parent_links()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.is_deleted = true AND OLD.is_deleted = false AND EXISTS (
    SELECT 1 FROM remittance_allocations WHERE remittance_id = OLD.id
  ) THEN
    RAISE EXCEPTION 'Remittance cannot be deleted while allocations reference it'
      USING ERRCODE = '23503',
            CONSTRAINT = 'remittances_active_allocation_links';
  END IF;

  IF (
    NEW.client_id IS DISTINCT FROM OLD.client_id
    OR NEW.authorization_id IS DISTINCT FROM OLD.authorization_id
  ) AND EXISTS (
    SELECT 1
    FROM remittance_allocations ra
    JOIN payments p ON p.id = ra.payment_id
    WHERE ra.remittance_id = OLD.id
      AND (
        p.is_deleted = true
        OR p.client_id <> NEW.client_id
        OR (NEW.authorization_id IS NOT NULL AND p.authorization_id IS DISTINCT FROM NEW.authorization_id)
      )
  ) THEN
    RAISE EXCEPTION 'Remittance client or authorization cannot change while allocations would become invalid'
      USING ERRCODE = '23503',
            CONSTRAINT = 'remittances_active_allocation_links';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER remittances_financial_link_guard
BEFORE UPDATE OF is_deleted, client_id, authorization_id
ON remittances
FOR EACH ROW
EXECUTE FUNCTION enforce_remittance_allocation_parent_links();--> statement-breakpoint

CREATE FUNCTION require_active_financial_parent(
  parent_table regclass,
  parent_id uuid,
  constraint_name text,
  error_message text
)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  parent_is_deleted boolean;
BEGIN
  IF parent_id IS NULL THEN
    RETURN;
  END IF;

  EXECUTE format('SELECT is_deleted FROM %s WHERE id = $1 FOR SHARE', parent_table)
    INTO parent_is_deleted
    USING parent_id;

  IF parent_is_deleted IS DISTINCT FROM false THEN
    RAISE EXCEPTION '%', error_message
      USING ERRCODE = '23503',
            CONSTRAINT = constraint_name;
  END IF;
END;
$$;--> statement-breakpoint

CREATE FUNCTION require_active_linked_financial_parent(
  parent_table regclass,
  parent_id uuid,
  expected_client_id uuid,
  constraint_name text,
  error_message text
)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  valid_parent boolean;
BEGIN
  IF parent_id IS NULL THEN
    RETURN;
  END IF;

  EXECUTE format(
    'SELECT is_deleted = false AND client_id = $2 FROM %s WHERE id = $1 FOR SHARE',
    parent_table
  )
    INTO valid_parent
    USING parent_id, expected_client_id;

  IF valid_parent IS DISTINCT FROM true THEN
    RAISE EXCEPTION '%', error_message
      USING ERRCODE = '23503',
            CONSTRAINT = constraint_name;
  END IF;
END;
$$;--> statement-breakpoint

CREATE FUNCTION require_vendor_association(
  expected_client_id uuid,
  expected_vendor_id uuid,
  constraint_name text,
  error_message text
)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  vendor_exists boolean;
  association_exists boolean;
BEGIN
  IF expected_vendor_id IS NULL THEN
    RETURN;
  END IF;

  SELECT true INTO vendor_exists
  FROM vendors
  WHERE id = expected_vendor_id
  FOR SHARE;

  IF vendor_exists IS DISTINCT FROM true THEN
    RAISE EXCEPTION '%', error_message
      USING ERRCODE = '23503',
            CONSTRAINT = constraint_name;
  END IF;

  PERFORM id FROM authorizations
  WHERE client_id = expected_client_id
    AND vendor_id = expected_vendor_id
    AND is_deleted = false
  LIMIT 1
  FOR SHARE;
  association_exists := FOUND;

  IF NOT association_exists THEN
    PERFORM id FROM invoices
    WHERE client_id = expected_client_id
      AND vendor_id = expected_vendor_id
      AND is_deleted = false
    LIMIT 1
    FOR SHARE;
    association_exists := FOUND;
  END IF;

  IF NOT association_exists THEN
    PERFORM id FROM payments
    WHERE client_id = expected_client_id
      AND vendor_id = expected_vendor_id
      AND is_deleted = false
    LIMIT 1
    FOR SHARE;
    association_exists := FOUND;
  END IF;

  IF association_exists IS DISTINCT FROM true THEN
    RAISE EXCEPTION '%', error_message
      USING ERRCODE = '23503',
            CONSTRAINT = constraint_name;
  END IF;
END;
$$;--> statement-breakpoint

CREATE FUNCTION require_matching_remittance_payment(
  expected_client_id uuid,
  expected_authorization_id uuid,
  expected_payment_id uuid,
  constraint_name text,
  error_message text
)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  valid_payment boolean;
BEGIN
  IF expected_payment_id IS NULL THEN
    RETURN;
  END IF;

  SELECT (
    is_deleted = false
    AND client_id = expected_client_id
    AND (
      expected_authorization_id IS NULL
      OR authorization_id = expected_authorization_id
    )
  )
  INTO valid_payment
  FROM payments
  WHERE id = expected_payment_id
  FOR SHARE;

  IF valid_payment IS DISTINCT FROM true THEN
    RAISE EXCEPTION '%', error_message
      USING ERRCODE = '23503',
            CONSTRAINT = constraint_name;
  END IF;
END;
$$;--> statement-breakpoint

CREATE FUNCTION enforce_authorization_active_parents()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.is_deleted = false THEN
    PERFORM require_active_financial_parent(
      'clients'::regclass, NEW.client_id,
      'authorizations_active_client_link',
      'Active authorization must reference an active client'
    );
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER authorizations_active_parent_guard
BEFORE INSERT OR UPDATE OF client_id, is_deleted
ON authorizations
FOR EACH ROW
EXECUTE FUNCTION enforce_authorization_active_parents();--> statement-breakpoint

CREATE FUNCTION enforce_fee_active_parents()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.is_deleted = false THEN
    PERFORM require_active_financial_parent(
      'clients'::regclass, NEW.client_id,
      'fees_active_client_link',
      'Active fee must reference an active client'
    );
    PERFORM require_active_linked_financial_parent(
      'authorizations'::regclass, NEW.authorization_id, NEW.client_id,
      'fees_active_authorization_link',
      'Active fee must reference an active authorization for its client'
    );
    PERFORM require_active_linked_financial_parent(
      'payments'::regclass, NEW.payment_id, NEW.client_id,
      'fees_active_payment_link',
      'Active fee must reference an active payment for its client'
    );
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER fees_active_parent_guard
BEFORE INSERT OR UPDATE OF client_id, authorization_id, payment_id, is_deleted
ON fees
FOR EACH ROW
EXECUTE FUNCTION enforce_fee_active_parents();--> statement-breakpoint

CREATE FUNCTION enforce_invoice_active_parents()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.is_deleted = false THEN
    PERFORM require_active_financial_parent(
      'clients'::regclass, NEW.client_id,
      'invoices_active_client_link',
      'Active invoice must reference an active client'
    );
    PERFORM require_active_linked_financial_parent(
      'authorizations'::regclass, NEW.authorization_id, NEW.client_id,
      'invoices_active_authorization_link',
      'Active invoice must reference an active authorization for its client'
    );
    PERFORM require_vendor_association(
      NEW.client_id, NEW.vendor_id,
      'invoices_vendor_association',
      'Active invoice vendor must already be associated with its client'
    );
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER invoices_active_parent_guard
BEFORE INSERT OR UPDATE OF client_id, authorization_id, vendor_id, is_deleted
ON invoices
FOR EACH ROW
EXECUTE FUNCTION enforce_invoice_active_parents();--> statement-breakpoint

CREATE FUNCTION enforce_payment_active_parents()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.is_deleted = false THEN
    PERFORM require_active_financial_parent(
      'clients'::regclass, NEW.client_id,
      'payments_active_client_link',
      'Active payment must reference an active client'
    );
    PERFORM require_active_linked_financial_parent(
      'authorizations'::regclass, NEW.authorization_id, NEW.client_id,
      'payments_active_authorization_link',
      'Active payment must reference an active authorization for its client'
    );
    PERFORM require_active_linked_financial_parent(
      'invoices'::regclass, NEW.invoice_id, NEW.client_id,
      'payments_active_invoice_link',
      'Active payment must reference an active invoice for its client'
    );
    PERFORM require_vendor_association(
      NEW.client_id, NEW.vendor_id,
      'payments_vendor_association',
      'Active payment vendor must already be associated with its client'
    );
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER payments_active_parent_guard
BEFORE INSERT OR UPDATE OF client_id, authorization_id, invoice_id, vendor_id, is_deleted
ON payments
FOR EACH ROW
EXECUTE FUNCTION enforce_payment_active_parents();--> statement-breakpoint

CREATE FUNCTION enforce_remittance_active_parents()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.is_deleted = false THEN
    PERFORM require_active_financial_parent(
      'clients'::regclass, NEW.client_id,
      'remittances_active_client_link',
      'Active remittance must reference an active client'
    );
    PERFORM require_active_linked_financial_parent(
      'authorizations'::regclass, NEW.authorization_id, NEW.client_id,
      'remittances_active_authorization_link',
      'Active remittance must reference an active authorization for its client'
    );
    PERFORM require_matching_remittance_payment(
      NEW.client_id, NEW.authorization_id, NEW.matched_payment_id,
      'remittances_active_payment_link',
      'Matched remittance payment must be active and belong to the same client and authorization'
    );
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER remittances_active_parent_guard
BEFORE INSERT OR UPDATE OF client_id, authorization_id, matched_payment_id, is_deleted
ON remittances
FOR EACH ROW
EXECUTE FUNCTION enforce_remittance_active_parents();--> statement-breakpoint

CREATE FUNCTION enforce_remittance_allocation_active_links()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  remittance_client_id uuid;
  remittance_authorization_id uuid;
  remittance_is_deleted boolean;
BEGIN
  SELECT client_id, authorization_id, is_deleted
  INTO remittance_client_id, remittance_authorization_id, remittance_is_deleted
  FROM remittances
  WHERE id = NEW.remittance_id
  FOR SHARE;

  IF remittance_is_deleted IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'Allocation must reference an active remittance'
      USING ERRCODE = '23503',
            CONSTRAINT = 'remittance_allocations_active_remittance_link';
  END IF;

  PERFORM require_matching_remittance_payment(
    remittance_client_id, remittance_authorization_id, NEW.payment_id,
    'remittance_allocations_active_payment_link',
    'Allocation payment must be active and belong to the remittance client and authorization'
  );
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER remittance_allocations_active_links_guard
BEFORE INSERT OR UPDATE OF remittance_id, payment_id
ON remittance_allocations
FOR EACH ROW
EXECUTE FUNCTION enforce_remittance_allocation_active_links();
-- Custom SQL migration file, put your code below! --