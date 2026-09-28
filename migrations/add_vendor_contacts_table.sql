-- Run in Supabase SQL editor before using the vendor-contact persistence
-- in the Send Mail recipient dialog (InspectionReportEntry.jsx /
-- SendRecipientsModal.jsx). Stores a vendor/supplier org's saved contacts
-- (name + email) so a QA never has to re-type the same rep's email on
-- every future PO tied to that same vendor.

CREATE TABLE IF NOT EXISTS vendor_contacts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id),
  name text,
  email text not null,
  created_by text,
  created_by_member_id uuid references organization_members(id),
  created_at timestamptz not null default now(),
  unique (organization_id, email)
);

CREATE INDEX IF NOT EXISTS vendor_contacts_organization_id_idx ON vendor_contacts (organization_id);
