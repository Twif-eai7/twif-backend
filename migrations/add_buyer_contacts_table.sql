-- Run in Supabase SQL editor before using the "Add Contact" (buyer-side)
-- persistence in the Send Mail recipient dialog (InspectionReportEntry.jsx /
-- SendRecipientsModal.jsx). Buyer-side counterpart to vendor_contacts -
-- stores a buyer/merchant's saved contacts (name + email) so a QA never has
-- to re-type the same person's email on every future PO tied to that same
-- buyer.

CREATE TABLE IF NOT EXISTS buyer_contacts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id),
  name text,
  email text not null,
  created_by text,
  created_by_member_id uuid references organization_members(id),
  created_at timestamptz not null default now(),
  unique (organization_id, email)
);

CREATE INDEX IF NOT EXISTS buyer_contacts_organization_id_idx ON buyer_contacts (organization_id);
