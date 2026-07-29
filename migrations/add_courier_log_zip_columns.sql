-- Run in Supabase SQL editor before using zip/pincode fields in courier logs.

ALTER TABLE domestic_courier_logs_outwards
  ADD COLUMN IF NOT EXISTS zip_code text;

ALTER TABLE international_courier_logs_export
  ADD COLUMN IF NOT EXISTS zip_code_V text,
  ADD COLUMN IF NOT EXISTS zip_code_B text;
