const XLSX = require('xlsx');
const puppeteer = require('puppeteer');

async function convertAndStorePdf(supabase, buildFileRef, storagePath, poId, bucket, fileType = 'po') {
  const pdfStoragePath = storagePath.replace(/\.[^/.]+$/, '.pdf');

  // 1. Download original Excel from storage
  const { data, error } = await supabase.storage.from(bucket).download(storagePath);
  if (error) throw error;

  const buffer = Buffer.from(await data.arrayBuffer());

  // 2. Parse Excel → HTML using SheetJS
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  const sheetName = workbook.SheetNames[0];
  const html = XLSX.utils.sheet_to_html(workbook.Sheets[sheetName]);

  const fullHtml = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  body { font-family: Arial, sans-serif; font-size: 11px; margin: 20px; }
  table { border-collapse: collapse; width: 100%; }
  td, th { border: 1px solid #ccc; padding: 4px 8px; }
  th { background: #f0f0f0; font-weight: bold; }
</style>
</head>
<body>${html}</body>
</html>`;

  // 3. Render HTML → PDF with Puppeteer
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
  let pdfBuffer;
  try {
    const page = await browser.newPage();
    await page.setContent(fullHtml, { waitUntil: 'networkidle0' });
    pdfBuffer = await page.pdf({ format: 'A4', printBackground: true, landscape: true });
  } finally {
    await browser.close();
  }

  // 4. Upload PDF to storage
  const { error: uploadError } = await supabase.storage
    .from(bucket)
    .upload(pdfStoragePath, pdfBuffer, { contentType: 'application/pdf', upsert: true });

  if (uploadError) throw uploadError;

  // 5. Update DB
  const column = fileType === 'pi' ? 'pi_pdf_url' : 'po_pdf_url';
  const { error: dbError } = await supabase
    .from('purchase_orders')
    .update({ [column]: buildFileRef(pdfStoragePath, bucket) })
    .eq('id', poId);

  if (dbError) throw dbError;

  console.log(`✅ PDF stored: ${pdfStoragePath}`);
}

module.exports = { convertAndStorePdf };
