const express = require('express')
const router = express.Router()
const supabase = require('../supabaseClient')
const PDFDocument = require("pdfkit");

const COMPANY = {
  name: "TWIF TECH LLP",
  addressLines: [
    "Plot No.36, Sector 37, Pace city-1,",
    "Gurgaon, Haryana-122001",
  ],
  country: "INDIA",
  gstin: "06AAPFJ1459D1ZD",
  pan: "AAPFJ1459D",
  cin: "AAO-8540",
  email: "hi@eai7.com",
};

const BANK = {
  beneficiary: {
    accountName: "TWIF TECH LLP",
    accountNumber: "8613138240",
    address: "PLOT NO. 36, PACE CITY I, SECTOR 37, GURGAON - 122 001",
    bankName: "Kotak Mahindra Bank Ltd.",
    bankAddress: "JMD Regent Square",
    ifsc: "KKBK0000261",
    swift: "KKBKINBBCPC",
  },
  intermediary: {
    bankName: "Citi Bank NA",
    nostroAccount: "36317907",
    swift: "CITI US 33",
  },
};

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────
function formatDate(dateStr) {
  try {
    const d = new Date(dateStr + "T00:00:00");
    return d.toLocaleDateString("en-GB", {
      day: "2-digit",
      month: "short",
      year: "numeric",
    });
  } catch {
    return dateStr;
  }
}

function formatAmount(num) {
  return Number(num).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

// ─────────────────────────────────────────────────────────────
// PDF GENERATION (unchanged)
// ─────────────────────────────────────────────────────────────
function generateInvoicePDF(data) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: "A4",
      margins: { top: 40, bottom: 40, left: 40, right: 40 },
    });

    const chunks = [];
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const pageWidth = doc.page.width;
    const left = doc.page.margins.left;
    const right = pageWidth - doc.page.margins.right;
    const contentWidth = right - left;

    const BLACK = "#1a1a1a";
    const DARK_GRAY = "#374151";
    const MID_GRAY = "#6b7280";
    const LIGHT_GRAY = "#e5e7eb";
    const LIGHTER_GRAY = "#f3f4f6";

    let y = doc.page.margins.top;

    doc.font("Helvetica-Bold").fontSize(28).fillColor(BLACK).text("INVOICE", left, y);
    y += 36;

    doc.strokeColor(BLACK).lineWidth(2).moveTo(left, y).lineTo(left + 90, y).stroke();
    y += 20;

    const companyTop = y;

    doc.font("Helvetica-Bold").fontSize(13).fillColor(BLACK).text(COMPANY.name, left, y);
    y += 18;

    doc.font("Helvetica").fontSize(9).fillColor(DARK_GRAY);
    for (const line of COMPANY.addressLines) {
      doc.text(line, left, y);
      y += 13;
    }
    doc.text(COMPANY.country, left, y);
    y += 16;

    doc.fontSize(8).fillColor(MID_GRAY);
    doc.text(`GSTIN : ${COMPANY.gstin}`, left, y);
    y += 11;
    doc.text(`PAN : ${COMPANY.pan}, CIN : ${COMPANY.cin}`, left, y);
    y += 11;
    doc.text(`Email: ${COMPANY.email}`, left, y);

    const metaX = right - 190;
    const metaY = companyTop;

    doc.roundedRect(metaX - 10, metaY - 6, 200, 56, 4).fillColor(LIGHTER_GRAY).fill();

    doc.font("Helvetica").fontSize(8).fillColor(MID_GRAY);
    doc.text("Invoice No", metaX, metaY);
    doc.font("Helvetica-Bold").fontSize(11).fillColor(BLACK).text(data.invoiceNo, metaX, metaY + 12);

    doc.font("Helvetica").fontSize(8).fillColor(MID_GRAY);
    doc.text("Date", metaX + 110, metaY);
    doc.font("Helvetica-Bold").fontSize(11).fillColor(BLACK).text(formatDate(data.invoiceDate), metaX + 110, metaY + 12);

    y += 22;

    doc.strokeColor(LIGHT_GRAY).lineWidth(0.5).moveTo(left, y).lineTo(right, y).stroke();
    y += 16;

    doc.font("Helvetica").fontSize(8).fillColor(MID_GRAY);
    doc.text("INVOICE TO", left, y);
    y += 14;

    const buyer = data.buyer || {};

    doc.font("Helvetica-Bold").fontSize(12).fillColor(BLACK);
    doc.text(buyer.name || "", left, y);
    y += 16;

    doc.font("Helvetica").fontSize(9.5).fillColor(DARK_GRAY);
    const addressLines = (buyer.address || "").split("\n");
    for (const line of addressLines) {
      const trimmed = line.trim();
      if (trimmed) {
        doc.text(trimmed, left, y);
        y += 13;
      }
    }
    if (buyer.country) {
      doc.text(buyer.country, left, y);
      y += 13;
    }

    y += 10;

    const lineItems = data.lineItems || [];
    const currency = data.currency || "USD";
    const totalAmount = data.totalAmount || 0;

    const cols = [
      { label: "Sr No.", width: 45, align: "center" },
      { label: "Description", width: contentWidth - 45 - 90 - 100, align: "left" },
      { label: "Purpose Code", width: 90, align: "center" },
      { label: `Total (${currency})`, width: 100, align: "right" },
    ];

    const rowHeight = 30;
    const headerHeight = 32;

    let xPos = left;
    doc.rect(left, y, contentWidth, headerHeight).fillColor(BLACK).fill();

    doc.font("Helvetica-Bold").fontSize(9).fillColor("#ffffff");
    xPos = left;
    for (const col of cols) {
      if (col.align === "center") {
        doc.text(col.label, xPos, y + 10, { width: col.width, align: "center" });
      } else if (col.align === "right") {
        doc.text(col.label, xPos, y + 10, { width: col.width - 8, align: "right" });
      } else {
        doc.text(col.label, xPos + 8, y + 10);
      }
      xPos += col.width;
    }

    y += headerHeight;

    for (let i = 0; i < lineItems.length; i++) {
      const item = lineItems[i];

      if (i % 2 === 1) {
        doc.rect(left, y, contentWidth, rowHeight).fillColor("#fafbfc").fill();
      }

      doc.font("Helvetica").fontSize(9).fillColor(DARK_GRAY);
      xPos = left;

      doc.text(String(item.srNo || i + 1), xPos, y + 9, { width: cols[0].width, align: "center" });
      xPos += cols[0].width;

      doc.text(item.description || "", xPos + 8, y + 9, { width: cols[1].width - 16 });
      xPos += cols[1].width;

      doc.text(item.purposeCode || "", xPos, y + 9, { width: cols[2].width, align: "center" });
      xPos += cols[2].width;

      doc.text(formatAmount(item.total || 0), xPos, y + 9, { width: cols[3].width - 8, align: "right" });

      doc.strokeColor(LIGHT_GRAY).lineWidth(0.3).moveTo(left, y + rowHeight).lineTo(right, y + rowHeight).stroke();

      y += rowHeight;
    }

    doc.rect(left, y, contentWidth, rowHeight + 4).fillColor(LIGHTER_GRAY).fill();
    doc.font("Helvetica-Bold").fontSize(10).fillColor(BLACK);
    doc.text("TOTAL", left + cols[0].width + 8, y + 10);
    doc.text(formatAmount(totalAmount), left + contentWidth - cols[3].width, y + 10, {
      width: cols[3].width - 8,
      align: "right",
    });

    doc.strokeColor(BLACK).lineWidth(1).moveTo(left, y + rowHeight + 4).lineTo(right, y + rowHeight + 4).stroke();
    y += rowHeight + 24;

    doc.strokeColor(LIGHT_GRAY).lineWidth(0.5).moveTo(left, y).lineTo(right, y).stroke();
    y += 14;

    doc.font("Helvetica-Bold").fontSize(8.5).fillColor(BLACK);
    doc.text("KINDLY REMIT FUNDS TO OUR BANK AS PER FOLLOWING DETAILS", left, y);
    y += 18;

    const bankLeftX = left;
    const bankRightX = left + contentWidth / 2 + 20;
    let bankY = y;

    const beneficiaryRows = [
      ["BENEFICIARY ACCOUNT NAME", BANK.beneficiary.accountName],
      ["BENEFICIARY ACCOUNT NUMBER", BANK.beneficiary.accountNumber],
      ["BENEFICIARY ADDRESS", BANK.beneficiary.address],
      ["BENEFICIARY BANK NAME", BANK.beneficiary.bankName],
      ["BENEFICIARY BANK ADDRESS", BANK.beneficiary.bankAddress],
      ["IFSC", BANK.beneficiary.ifsc],
      ["SWIFT CODE", BANK.beneficiary.swift],
    ];

    for (const [label, value] of beneficiaryRows) {
      doc.font("Helvetica").fontSize(7).fillColor(MID_GRAY);
      doc.text(label, bankLeftX, bankY);
      bankY += 10;
      doc.font("Helvetica-Bold").fontSize(8.5).fillColor(DARK_GRAY);
      doc.text(value, bankLeftX, bankY, { width: contentWidth / 2 - 10 });
      bankY += 14;
    }

    let interY = y;

    doc.font("Helvetica-Bold").fontSize(8).fillColor(BLACK);
    doc.text("INTERMEDIARY / CORRESPONDENT BANK", bankRightX, interY);
    interY += 16;

    const intermediaryRows = [
      ["BANK NAME", BANK.intermediary.bankName],
      ["NOSTRO ACCOUNT NUMBER", BANK.intermediary.nostroAccount],
      ["SWIFT CODE", BANK.intermediary.swift],
    ];

    for (const [label, value] of intermediaryRows) {
      doc.font("Helvetica").fontSize(7).fillColor(MID_GRAY);
      doc.text(label, bankRightX, interY);
      interY += 10;
      doc.font("Helvetica-Bold").fontSize(8.5).fillColor(DARK_GRAY);
      doc.text(value, bankRightX, interY);
      interY += 14;
    }

    const sigY = Math.max(bankY, interY) + 16;

    doc.font("Helvetica-Bold").fontSize(9).fillColor(BLACK);
    doc.text("FOR TWIF TECH LLP", right - 160, sigY, { width: 160, align: "right" });

    doc.strokeColor(LIGHT_GRAY).lineWidth(0.5).moveTo(right - 150, sigY + 36).lineTo(right, sigY + 36).stroke();

    doc.font("Helvetica").fontSize(8).fillColor(MID_GRAY);
    doc.text("AUTHORISED SIGNATORY", right - 160, sigY + 42, { width: 160, align: "right" });

    doc.end();
  });
}

// ═════════════════════════════════════════════════════════════
// POST /generate-invoice
// ═════════════════════════════════════════════════════════════
router.post("/generate-invoice", async (req, res) => {
  try {
    const {
      invoiceMode = "system",
      invoiceNo,
      invoiceDate,
      buyer,
      lineItems,
      totalAmount,
      currency = "USD",
      shopifyCustomerId,
    } = req.body;

    // ── Validation ──────────────────────────────────────────
    if (!invoiceNo?.trim())
      return res.status(400).json({ error: "Invoice number is required." });
    if (!invoiceDate)
      return res.status(400).json({ error: "Invoice date is required." });
    if (!buyer?.id)
      return res.status(400).json({ error: "Buyer is required." });
    if (!lineItems?.length)
      return res.status(400).json({ error: "At least one line item is required." });

    const trimmedInvoiceNo = invoiceNo.trim();
    const buyerId = buyer.id;

    // ── Resolve member ───────────────────────────────────────
    const { data: member } = await supabase
      .from("organization_members")
      .select("id")
      .eq("shopify_customer_id", shopifyCustomerId)
      .maybeSingle();

    if (!member)
      return res.status(400).json({ error: "Could not resolve member identity." });

    const createdBy = member.id;

    // ── Fetch series ─────────────────────────────────────────
    const { data: series, error: seriesError } = await supabase
      .from("invoice_series")
      .select("*")
      .eq("buyer_org_id", buyerId)
      .maybeSingle();

    if (seriesError) throw seriesError;
    if (!series)
      return res.status(400).json({ error: "Invoice series not configured for this buyer." });

    // ── Duplicate check (applies to both modes) ──────────────
    const { data: duplicate } = await supabase
      .from("consultancy_invoices")
      .select("id")
      .eq("invoice_number", trimmedInvoiceNo)
      .maybeSingle();

    if (duplicate)
      return res.status(400).json({ error: `Invoice number ${trimmedInvoiceNo} already exists.` });

    // ── Mode-specific logic ──────────────────────────────────
    let finalInvoiceNo = trimmedInvoiceNo;
    let sequenceNumber = null;

    if (invoiceMode === "system") {

      if (!series.auto_initialized) {
        // ── First-time setup: user picked the starting number ──
        const match = trimmedInvoiceNo.match(/-(\d+)N-/);
        if (!match)
          return res.status(400).json({ error: "Invalid invoice number format." });

        sequenceNumber = parseInt(match[1], 10);

        // Validate the number matches the expected format for this series
        const expectedFormat = `${series.prefix}-${String(sequenceNumber).padStart(3, "0")}N-${series.financial_year}`;
        if (trimmedInvoiceNo !== expectedFormat)
          return res.status(400).json({ error: `Invoice number format invalid. Expected format: ${expectedFormat}` });

        // Initialize the series — this is the only time we touch the counter for first-time
        const { error: initError } = await supabase
          .from("invoice_series")
          .update({ auto_current_number: sequenceNumber, auto_initialized: true })
          .eq("buyer_org_id", buyerId);

        if (initError) throw initError;

      } else {
        // ── Normal auto mode: claim next number atomically ──
        const { data: claimedNo, error: claimError } = await supabase
          .rpc("claim_next_invoice_number", { p_buyer_id: buyerId });

        if (claimError) throw claimError;

        // The frontend sends what it thinks is next — validate it matches
        // what the DB actually claimed (guards against stale UI state)
        if (trimmedInvoiceNo !== claimedNo) {
          return res.status(400).json({
            error: `Invoice number mismatch. Expected ${claimedNo}. Please refresh and try again.`,
          });
        }

        finalInvoiceNo = claimedNo;

        const match = claimedNo.match(/-(\d+)N-/);
        if (match) sequenceNumber = parseInt(match[1], 10);
      }

    } else if (invoiceMode === "manual") {
      // ── Manual: just extract sequence number for record-keeping ──
      // Series table is never touched
      const match = trimmedInvoiceNo.match(/-(\d+)N-/);
      if (match) sequenceNumber = parseInt(match[1], 10);
    }

    // ── Generate PDF ─────────────────────────────────────────
    const pdfBuffer = await generateInvoicePDF({ ...req.body, invoiceNo: finalInvoiceNo });

    const fileName = `invoices/${finalInvoiceNo.replace(/[^a-zA-Z0-9\-]/g, "_")}_${Date.now()}.pdf`;

    const { error: uploadError } = await supabase.storage
      .from("invoice-documents")
      .upload(fileName, pdfBuffer, { contentType: "application/pdf", upsert: false });

    if (uploadError) {
      console.error("Upload error:", uploadError);
      return res.status(500).json({ error: "Failed to upload invoice PDF." });
    }

    const { data: urlData } = supabase.storage
      .from("invoice-documents")
      .getPublicUrl(fileName);

    const downloadUrl = urlData?.publicUrl || null;

    // ── Insert record ────────────────────────────────────────
    const { data: record, error: dbError } = await supabase
      .from("consultancy_invoices")
      .insert({
        buyer_org_id: buyerId,
        invoice_number: finalInvoiceNo,
        invoice_date: invoiceDate,
        amount: totalAmount,
        currency,
        line_items: lineItems,
        description: "Consultancy Services",
        status: "issued",
        sequence_number: sequenceNumber,
        invoice_mode: invoiceMode,
        pdf_path: fileName,
        created_by: createdBy,
        financial_year: series.financial_year,
      })
      .select()
      .single();

    if (dbError) {
      console.error("DB insert error:", dbError);
      // Note: if this fails in auto mode, the counter already incremented.
      // That gap is acceptable — do NOT attempt to roll back the counter.
      return res.status(500).json({
        error: "Invoice PDF generated but failed to save record. Contact support with invoice number: " + finalInvoiceNo,
        downloadUrl,
      });
    }

    return res.json({
      success: true,
      invoiceId: record.id,
      downloadUrl,
      viewUrl: `/apps/proxy-1/consultancy/view-invoice/${record.id}`,
      message: "Invoice generated successfully.",
    });

  } catch (error) {
    console.error("Invoice generation error:", error);
    return res.status(500).json({ error: "Internal server error." });
  }
});


router.post("/gen-invoice", async (req, res) => {
  try {
    const {
      invoiceMode = "system",
      invoiceNo,
      invoiceDate,
      buyer,
      lineItems,
      totalAmount,
      currency = "USD",
      memberId,
    } = req.body;

    // ── Validation ──────────────────────────────────────────
    if (!invoiceNo?.trim())
      return res.status(400).json({ error: "Invoice number is required." });
    if (!invoiceDate)
      return res.status(400).json({ error: "Invoice date is required." });
    if (!buyer?.id)
      return res.status(400).json({ error: "Buyer is required." });
    if (!lineItems?.length)
      return res.status(400).json({ error: "At least one line item is required." });

    const trimmedInvoiceNo = invoiceNo.trim();
    const buyerId = buyer.id;

    const createdBy = memberId;

    // ── Fetch series ─────────────────────────────────────────
    const { data: series, error: seriesError } = await supabase
      .from("invoice_series")
      .select("*")
      .eq("buyer_org_id", buyerId)
      .maybeSingle();

    if (seriesError) throw seriesError;
    if (!series)
      return res.status(400).json({ error: "Invoice series not configured for this buyer." });

    // ── Duplicate check (applies to both modes) ──────────────
    const { data: duplicate } = await supabase
      .from("consultancy_invoices")
      .select("id")
      .eq("invoice_number", trimmedInvoiceNo)
      .maybeSingle();

    if (duplicate)
      return res.status(400).json({ error: `Invoice number ${trimmedInvoiceNo} already exists.` });

    // ── Mode-specific logic ──────────────────────────────────
    let finalInvoiceNo = trimmedInvoiceNo;
    let sequenceNumber = null;

    if (invoiceMode === "system") {

      if (!series.auto_initialized) {
        // ── First-time setup: user picked the starting number ──
        const match = trimmedInvoiceNo.match(/-(\d+)N-/);
        if (!match)
          return res.status(400).json({ error: "Invalid invoice number format." });

        sequenceNumber = parseInt(match[1], 10);

        // Validate the number matches the expected format for this series
        const expectedFormat = `${series.prefix}-${String(sequenceNumber).padStart(3, "0")}N-${series.financial_year}`;
        if (trimmedInvoiceNo !== expectedFormat)
          return res.status(400).json({ error: `Invoice number format invalid. Expected format: ${expectedFormat}` });

        // Initialize the series — this is the only time we touch the counter for first-time
        const { error: initError } = await supabase
          .from("invoice_series")
          .update({ auto_current_number: sequenceNumber, auto_initialized: true })
          .eq("buyer_org_id", buyerId);

        if (initError) throw initError;

      } else {
        // ── Normal auto mode: claim next number atomically ──
        const { data: claimedNo, error: claimError } = await supabase
          .rpc("claim_next_invoice_number", { p_buyer_id: buyerId });

        if (claimError) throw claimError;

        // The frontend sends what it thinks is next — validate it matches
        // what the DB actually claimed (guards against stale UI state)
        if (trimmedInvoiceNo !== claimedNo) {
          return res.status(400).json({
            error: `Invoice number mismatch. Expected ${claimedNo}. Please refresh and try again.`,
          });
        }

        finalInvoiceNo = claimedNo;

        const match = claimedNo.match(/-(\d+)N-/);
        if (match) sequenceNumber = parseInt(match[1], 10);
      }

    } else if (invoiceMode === "manual") {
      // ── Manual: just extract sequence number for record-keeping ──
      // Series table is never touched
      const match = trimmedInvoiceNo.match(/-(\d+)N-/);
      if (match) sequenceNumber = parseInt(match[1], 10);
    }

    // ── Generate PDF ─────────────────────────────────────────
    const pdfBuffer = await generateInvoicePDF({ ...req.body, invoiceNo: finalInvoiceNo });

    const fileName = `invoices/${finalInvoiceNo.replace(/[^a-zA-Z0-9\-]/g, "_")}_${Date.now()}.pdf`;

    const { error: uploadError } = await supabase.storage
      .from("invoice-documents")
      .upload(fileName, pdfBuffer, { contentType: "application/pdf", upsert: false });

    if (uploadError) {
      console.error("Upload error:", uploadError);
      return res.status(500).json({ error: "Failed to upload invoice PDF." });
    }

    const { data: urlData } = supabase.storage
      .from("invoice-documents")
      .getPublicUrl(fileName);

    const downloadUrl = urlData?.publicUrl || null;

    // ── Insert record ────────────────────────────────────────
    const { data: record, error: dbError } = await supabase
      .from("consultancy_invoices")
      .insert({
        buyer_org_id: buyerId,
        invoice_number: finalInvoiceNo,
        invoice_date: invoiceDate,
        amount: totalAmount,
        currency,
        line_items: lineItems,
        description: "Consultancy Services",
        status: "issued",
        sequence_number: sequenceNumber,
        invoice_mode: invoiceMode,
        pdf_path: fileName,
        created_by: createdBy,
        financial_year: series.financial_year,
      })
      .select()
      .single();

    if (dbError) {
      console.error("DB insert error:", dbError);
      // Note: if this fails in auto mode, the counter already incremented.
      // That gap is acceptable — do NOT attempt to roll back the counter.
      return res.status(500).json({
        error: "Invoice PDF generated but failed to save record. Contact support with invoice number: " + finalInvoiceNo,
        downloadUrl,
      });
    }

    return res.json({
      success: true,
      invoiceId: record.id,
      message: "Invoice generated successfully.",
    });

  } catch (error) {
    console.error("Invoice generation error:", error);
    return res.status(500).json({ error: "Internal server error." });
  }
});


// ═════════════════════════════════════════════════════════════
// GET /next-invoice-number
// ═════════════════════════════════════════════════════════════
router.get("/next-invoice-number", async (req, res) => {
  try {
    const { buyerId } = req.query;
    if (!buyerId)
      return res.status(400).json({ error: "buyerId required" });

    const { data: series, error } = await supabase
      .from("invoice_series")
      .select("*")
      .eq("buyer_org_id", buyerId)
      .maybeSingle();

    if (error) throw error;

    // No series configured at all
    if (!series) {
      return res.json({ configured: false });
    }

    // Series exists but auto not yet initialized
    if (!series.auto_initialized) {
      return res.json({
        configured: true,
        auto_initialized: false,
        prefix: series.prefix,
        financial_year: series.financial_year,
      });
    }

    // Walk forward from current_number until we find a free slot
    let nextNumber = series.auto_current_number + 1;
    const maxAttempts = 50;
    let attempts = 0;

    while (attempts < maxAttempts) {
    const padded = String(nextNumber).padStart(3, "0");
    const candidate = `${series.prefix}-${padded}N-${series.financial_year}`;

    const { data: existing } = await supabase
        .from("consultancy_invoices")
        .select("id")
        .eq("invoice_number", candidate)
        .maybeSingle();

    if (!existing) break;

    nextNumber++;
    attempts++;
    }

    const padded = String(nextNumber).padStart(3, "0");
    const invoiceNo = `${series.prefix}-${padded}N-${series.financial_year}`;

    return res.json({
    configured: true,
    auto_initialized: true,
    invoiceNo,
    prefix: series.prefix,
    financial_year: series.financial_year,
    current_number: series.auto_current_number,
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch invoice series" });
  }
});

//view invoice
router.get("/view-invoice/:invoiceId", async (req, res) => {
  try {
    const { invoiceId } = req.params;

    const { data: invoice } = await supabase
      .from("consultancy_invoices")
      .select("pdf_path")
      .eq("id", invoiceId)
      .single();

    if (!invoice) return res.status(404).json({ error: "Not found" });

    const { data, error } = await supabase.storage
      .from("invoice-documents")
      .download(invoice.pdf_path);

    if (error) throw error;

    const arrayBuffer = await data.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    // This header is the key — tells browser to display, not download
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", "inline");
    res.send(buffer);

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to serve invoice" });
  }
});

module.exports = router;

// Frontend — update the open block
// if (result.viewUrl) {
//   window.open(result.viewUrl, '_blank');
// }


router.get('/invoices', async (req, res) => {
  try {
    const { shopifyCustomerId } = req.query;

    if (!shopifyCustomerId) {
      return res.status(400).json({ error: 'shopifyCustomerId required' });
    }

    // Resolve member
    const { data: member } = await supabase
      .from('organization_members')
      .select('id, organization_id')
      .eq('shopify_customer_id', shopifyCustomerId)
      .maybeSingle();

    if (!member) {
      return res.status(400).json({ error: 'Member not found.' });
    }

    const { data: invoices, error } = await supabase
      .from('consultancy_invoices')
      .select(`
        id,
        invoice_number,
        invoice_date,
        amount,
        currency,
        status,
        invoice_mode,
        financial_year,
        pdf_path,
        created_at,
        buyer_org_id
      `)
      .order('created_at', { ascending: false });
  
    //   .eq('buyer_org_id', member.organization_id) // scope to their org

    if (error) throw error;

    return res.json({ invoices });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch invoices.' });
  }
});
























// const express = require('express')
// const router = express.Router()
// const supabase = require('../supabaseClient')
// const PDFDocument = require("pdfkit");
// const { shopify } = require('../shopify');



// const COMPANY = {
//   name: "TWIF TECH LLP",
//   addressLines: [
//     "Plot No.36, Sector 37, Pace city-1,",
//     "Gurgaon, Haryana-122001",
//   ],
//   country: "INDIA",
//   gstin: "06AAPFJ1459D1ZD",
//   pan: "AAPFJ1459D",
//   cin: "AAO-8540",
//   email: "hi@eai7.com",
// };

// const BANK = {
//   beneficiary: {
//     accountName: "TWIF TECH LLP",
//     accountNumber: "8613138240",
//     address: "PLOT NO. 36, PACE CITY I, SECTOR 37, GURGAON - 122 001",
//     bankName: "Kotak Mahindra Bank Ltd.",
//     bankAddress: "JMD Regent Square",
//     ifsc: "KKBK0000261",
//     swift: "KKBKINBBCPC",
//   },
//   intermediary: {
//     bankName: "Citi Bank NA",
//     nostroAccount: "36317907",
//     swift: "CITI US 33",
//   },
// };

// // ─────────────────────────────────────────────────────────────
// // HELPER: Format date from YYYY-MM-DD → "02 Feb 2026"
// // ─────────────────────────────────────────────────────────────
// function formatDate(dateStr) {
//   try {
//     const d = new Date(dateStr + "T00:00:00");
//     return d.toLocaleDateString("en-GB", {
//       day: "2-digit",
//       month: "short",
//       year: "numeric",
//     });
//   } catch {
//     return dateStr;
//   }
// }

// // ─────────────────────────────────────────────────────────────
// // HELPER: Format number with commas → "2,800.00"
// // ─────────────────────────────────────────────────────────────
// function formatAmount(num) {
//   return Number(num).toLocaleString("en-US", {
//     minimumFractionDigits: 2,
//     maximumFractionDigits: 2,
//   });
// }

// // ─────────────────────────────────────────────────────────────
// // PDF GENERATION FUNCTION
// // ─────────────────────────────────────────────────────────────
// function generateInvoicePDF(data) {
//   return new Promise((resolve, reject) => {
//     const doc = new PDFDocument({
//       size: "A4",
//       margins: { top: 40, bottom: 40, left: 40, right: 40 },
//     });

//     const chunks = [];
//     doc.on("data", (chunk) => chunks.push(chunk));
//     doc.on("end", () => resolve(Buffer.concat(chunks)));
//     doc.on("error", reject);

//     const pageWidth = doc.page.width;
//     const left = doc.page.margins.left;
//     const right = pageWidth - doc.page.margins.right;
//     const contentWidth = right - left;

//     const BLACK = "#1a1a1a";
//     const DARK_GRAY = "#374151";
//     const MID_GRAY = "#6b7280";
//     const LIGHT_GRAY = "#e5e7eb";
//     const LIGHTER_GRAY = "#f3f4f6";

//     let y = doc.page.margins.top;

//     // ══════════════════════════════════════
//     // HEADER — "INVOICE"
//     // ══════════════════════════════════════
//     doc
//       .font("Helvetica-Bold")
//       .fontSize(28)
//       .fillColor(BLACK)
//       .text("INVOICE", left, y);

//     y += 36;

//     // Accent line
//     doc
//       .strokeColor(BLACK)
//       .lineWidth(2)
//       .moveTo(left, y)
//       .lineTo(left + 90, y)
//       .stroke();

//     y += 20;

//     // ══════════════════════════════════════
//     // COMPANY INFO (left) + INVOICE META (right)
//     // ══════════════════════════════════════
//     const companyTop = y;

//     // Company name
//     doc
//       .font("Helvetica-Bold")
//       .fontSize(13)
//       .fillColor(BLACK)
//       .text(COMPANY.name, left, y);
//     y += 18;

//     // Address
//     doc.font("Helvetica").fontSize(9).fillColor(DARK_GRAY);
//     for (const line of COMPANY.addressLines) {
//       doc.text(line, left, y);
//       y += 13;
//     }
//     doc.text(COMPANY.country, left, y);
//     y += 16;

//     // GSTIN, PAN, Email
//     doc.fontSize(8).fillColor(MID_GRAY);
//     doc.text(`GSTIN : ${COMPANY.gstin}`, left, y);
//     y += 11;
//     doc.text(`PAN : ${COMPANY.pan}, CIN : ${COMPANY.cin}`, left, y);
//     y += 11;
//     doc.text(`Email: ${COMPANY.email}`, left, y);

//     // ── Invoice No & Date — right side ──
//     const metaX = right - 190;
//     const metaY = companyTop;

//     // Background box
//     doc
//       .roundedRect(metaX - 10, metaY - 6, 200, 56, 4)
//       .fillColor(LIGHTER_GRAY)
//       .fill();

//     // Invoice No
//     doc.font("Helvetica").fontSize(8).fillColor(MID_GRAY);
//     doc.text("Invoice No", metaX, metaY);
//     doc
//       .font("Helvetica-Bold")
//       .fontSize(11)
//       .fillColor(BLACK)
//       .text(data.invoiceNo, metaX, metaY + 12);

//     // Date
//     doc.font("Helvetica").fontSize(8).fillColor(MID_GRAY);
//     doc.text("Date", metaX + 110, metaY);
//     doc
//       .font("Helvetica-Bold")
//       .fontSize(11)
//       .fillColor(BLACK)
//       .text(formatDate(data.invoiceDate), metaX + 110, metaY + 12);

//     y += 22;

//     // ══════════════════════════════════════
//     // INVOICE TO (Buyer)
//     // ══════════════════════════════════════
//     doc
//       .strokeColor(LIGHT_GRAY)
//       .lineWidth(0.5)
//       .moveTo(left, y)
//       .lineTo(right, y)
//       .stroke();
//     y += 16;

//     doc.font("Helvetica").fontSize(8).fillColor(MID_GRAY);
//     doc.text("INVOICE TO", left, y);
//     y += 14;

//     const buyer = data.buyer || {};

//     doc.font("Helvetica-Bold").fontSize(12).fillColor(BLACK);
//     doc.text(buyer.name || "", left, y);
//     y += 16;

//     doc.font("Helvetica").fontSize(9.5).fillColor(DARK_GRAY);
//     const addressLines = (buyer.address || "").split("\n");
//     for (const line of addressLines) {
//       const trimmed = line.trim();
//       if (trimmed) {
//         doc.text(trimmed, left, y);
//         y += 13;
//       }
//     }
//     if (buyer.country) {
//       doc.text(buyer.country, left, y);
//       y += 13;
//     }

//     y += 10;

//     // ══════════════════════════════════════
//     // LINE ITEMS TABLE
//     // ══════════════════════════════════════
//     const lineItems = data.lineItems || [];
//     const currency = data.currency || "USD";
//     const totalAmount = data.totalAmount || 0;

//     // Column definitions
//     const cols = [
//       { label: "Sr No.", width: 45, align: "center" },
//       {
//         label: "Description",
//         width: contentWidth - 45 - 90 - 100,
//         align: "left",
//       },
//       { label: "Purpose Code", width: 90, align: "center" },
//       { label: `Total (${currency})`, width: 100, align: "right" },
//     ];

//     const rowHeight = 30;
//     const headerHeight = 32;

//     // ── Header row ──
//     let xPos = left;
//     doc
//       .rect(left, y, contentWidth, headerHeight)
//       .fillColor(BLACK)
//       .fill();

//     doc.font("Helvetica-Bold").fontSize(9).fillColor("#ffffff");
//     xPos = left;
//     for (const col of cols) {
//       const textX =
//         col.align === "center"
//           ? xPos + col.width / 2
//           : col.align === "right"
//           ? xPos + col.width - 8
//           : xPos + 8;
//       const textOpts =
//         col.align === "center"
//           ? { width: col.width, align: "center" }
//           : col.align === "right"
//           ? { width: col.width - 8, align: "right" }
//           : {};

//       if (col.align === "center") {
//         doc.text(col.label, xPos, y + 10, {
//           width: col.width,
//           align: "center",
//         });
//       } else if (col.align === "right") {
//         doc.text(col.label, xPos, y + 10, {
//           width: col.width - 8,
//           align: "right",
//         });
//       } else {
//         doc.text(col.label, xPos + 8, y + 10);
//       }
//       xPos += col.width;
//     }

//     y += headerHeight;

//     // ── Data rows ──
//     for (let i = 0; i < lineItems.length; i++) {
//       const item = lineItems[i];

//       // Alternating row background
//       if (i % 2 === 1) {
//         doc
//           .rect(left, y, contentWidth, rowHeight)
//           .fillColor("#fafbfc")
//           .fill();
//       }

//       doc.font("Helvetica").fontSize(9).fillColor(DARK_GRAY);

//       xPos = left;

//       // Sr No
//       doc.text(String(item.srNo || i + 1), xPos, y + 9, {
//         width: cols[0].width,
//         align: "center",
//       });
//       xPos += cols[0].width;

//       // Description
//       doc.text(item.description || "", xPos + 8, y + 9, {
//         width: cols[1].width - 16,
//       });
//       xPos += cols[1].width;

//       // Purpose Code
//       doc.text(item.purposeCode || "", xPos, y + 9, {
//         width: cols[2].width,
//         align: "center",
//       });
//       xPos += cols[2].width;

//       // Total
//       doc.text(formatAmount(item.total || 0), xPos, y + 9, {
//         width: cols[3].width - 8,
//         align: "right",
//       });

//       // Bottom line
//       doc
//         .strokeColor(LIGHT_GRAY)
//         .lineWidth(0.3)
//         .moveTo(left, y + rowHeight)
//         .lineTo(right, y + rowHeight)
//         .stroke();

//       y += rowHeight;
//     }

//     // ── Total row ──
//     doc
//       .rect(left, y, contentWidth, rowHeight + 4)
//       .fillColor(LIGHTER_GRAY)
//       .fill();

//     doc.font("Helvetica-Bold").fontSize(10).fillColor(BLACK);

//     // "TOTAL" label
//     doc.text("TOTAL", left + cols[0].width + 8, y + 10);

//     // Total amount
//     doc.text(formatAmount(totalAmount), left + contentWidth - cols[3].width, y + 10, {
//       width: cols[3].width - 8,
//       align: "right",
//     });

//     // Bottom border
//     doc
//       .strokeColor(BLACK)
//       .lineWidth(1)
//       .moveTo(left, y + rowHeight + 4)
//       .lineTo(right, y + rowHeight + 4)
//       .stroke();

//     y += rowHeight + 24;

//     // ══════════════════════════════════════
//     // BANK DETAILS
//     // ══════════════════════════════════════
//     doc
//       .strokeColor(LIGHT_GRAY)
//       .lineWidth(0.5)
//       .moveTo(left, y)
//       .lineTo(right, y)
//       .stroke();
//     y += 14;

//     doc.font("Helvetica-Bold").fontSize(8.5).fillColor(BLACK);
//     doc.text(
//       "KINDLY REMIT FUNDS TO OUR BANK AS PER FOLLOWING DETAILS",
//       left,
//       y
//     );
//     y += 18;

//     // ── Beneficiary (left column) ──
//     const bankLeftX = left;
//     const bankRightX = left + contentWidth / 2 + 20;
//     let bankY = y;

//     const beneficiaryRows = [
//       ["BENEFICIARY ACCOUNT NAME", BANK.beneficiary.accountName],
//       ["BENEFICIARY ACCOUNT NUMBER", BANK.beneficiary.accountNumber],
//       ["BENEFICIARY ADDRESS", BANK.beneficiary.address],
//       ["BENEFICIARY BANK NAME", BANK.beneficiary.bankName],
//       ["BENEFICIARY BANK ADDRESS", BANK.beneficiary.bankAddress],
//       ["IFSC", BANK.beneficiary.ifsc],
//       ["SWIFT CODE", BANK.beneficiary.swift],
//     ];

//     for (const [label, value] of beneficiaryRows) {
//       doc.font("Helvetica").fontSize(7).fillColor(MID_GRAY);
//       doc.text(label, bankLeftX, bankY);
//       bankY += 10;
//       doc.font("Helvetica-Bold").fontSize(8.5).fillColor(DARK_GRAY);
//       doc.text(value, bankLeftX, bankY, {
//         width: contentWidth / 2 - 10,
//       });
//       bankY += 14;
//     }

//     // ── Intermediary bank (right column) ──
//     let interY = y;

//     doc.font("Helvetica-Bold").fontSize(8).fillColor(BLACK);
//     doc.text("INTERMEDIARY / CORRESPONDENT BANK", bankRightX, interY);
//     interY += 16;

//     const intermediaryRows = [
//       ["BANK NAME", BANK.intermediary.bankName],
//       ["NOSTRO ACCOUNT NUMBER", BANK.intermediary.nostroAccount],
//       ["SWIFT CODE", BANK.intermediary.swift],
//     ];

//     for (const [label, value] of intermediaryRows) {
//       doc.font("Helvetica").fontSize(7).fillColor(MID_GRAY);
//       doc.text(label, bankRightX, interY);
//       interY += 10;
//       doc.font("Helvetica-Bold").fontSize(8.5).fillColor(DARK_GRAY);
//       doc.text(value, bankRightX, interY);
//       interY += 14;
//     }

//     // ══════════════════════════════════════
//     // SIGNATURE AREA
//     // ══════════════════════════════════════
//     const sigY = Math.max(bankY, interY) + 16;

//     doc.font("Helvetica-Bold").fontSize(9).fillColor(BLACK);
//     doc.text("FOR TWIF TECH LLP", right - 160, sigY, {
//       width: 160,
//       align: "right",
//     });

//     doc
//       .strokeColor(LIGHT_GRAY)
//       .lineWidth(0.5)
//       .moveTo(right - 150, sigY + 36)
//       .lineTo(right, sigY + 36)
//       .stroke();

//     doc.font("Helvetica").fontSize(8).fillColor(MID_GRAY);
//     doc.text("AUTHORISED SIGNATORY", right - 160, sigY + 42, {
//       width: 160,
//       align: "right",
//     });

//     doc.end();
//   });
// }

// // ═════════════════════════════════════════════════════════════
// // POST /generate-invoice
// // ═════════════════════════════════════════════════════════════
// router.post("/generate-invoice", async (req, res) => {
//   try {
//     const data = req.body;

//     const {
//       invoiceMode = "system",
//       invoiceNo,
//       invoiceDate,
//       buyer,
//       lineItems,
//       totalAmount,
//       currency = "USD",
//       shopifyCustomerId
//     } = data;

//     // ─────────────────────────────
//     // BASIC VALIDATION
//     // ─────────────────────────────
//     if (!invoiceNo?.trim()) {
//       return res.status(400).json({ error: "Invoice number is required." });
//     }

//     if (!invoiceDate) {
//       return res.status(400).json({ error: "Invoice date is required." });
//     }

//     if (!buyer?.id) {
//       return res.status(400).json({ error: "Buyer is required." });
//     }

//     if (!lineItems?.length) {
//       return res.status(400).json({ error: "At least one line item is required." });
//     }

//     const trimmedInvoiceNo = invoiceNo.trim();
//     const buyerId = buyer.id;

//     // ─────────────────────────────
//     // DUPLICATE CHECK
//     // ─────────────────────────────
//     const { data: duplicate } = await supabase
//       .from("consultancy_invoices")
//       .select("id")
//       .eq("invoice_number", trimmedInvoiceNo)
//       .maybeSingle();

//     if (duplicate) {
//       return res.status(400).json({
//         error: "Invoice number already exists."
//       });
//     }

//     // Resolve member UUID from shopify_customer_id or email
//     const { data: member, error: memberError } = await supabase
//     .from('organization_members')
//     .select('id')
//     .eq('shopify_customer_id',shopifyCustomerId) // createdBy is currently the name, change this
//     .maybeSingle();

//     if (!member) {
//     return res.status(400).json({ error: 'Could not resolve member identity.' });
//     }

//     const createdBy = member.id; // now this is defined and correct

//     // ─────────────────────────────
//     // FETCH INVOICE SERIES
//     // ─────────────────────────────
//     const { data: series, error: seriesError } = await supabase
//       .from("invoice_series")
//       .select("*")
//       .eq("buyer_org_id", buyerId)
//       .maybeSingle();

//     if (seriesError) throw seriesError;

//     if (!series) {
//       return res.status(400).json({
//         error: "Invoice series not configured for this buyer."
//       });
//     }

//     let sequenceNumber = null;

//     // ─────────────────────────────
//     // SYSTEM MODE (STRICT)
//     // ─────────────────────────────
//     if (invoiceMode === "system") {

//       if (!series.initialized) {
//         return res.status(400).json({
//           error: "Invoice series not initialized for this buyer."
//         });
//       }

//       const expectedNext = series.current_number + 1;
//       const padded = String(expectedNext).padStart(3, "0");
//       const expectedInvoice =
//         `${series.prefix}-${padded}N-${series.financial_year}`;

//       if (trimmedInvoiceNo !== expectedInvoice) {
//         return res.status(400).json({
//           error: `Invoice number mismatch. Expected ${expectedInvoice}`
//         });
//       }

//       sequenceNumber = expectedNext;
//     }

//     // ─────────────────────────────
//     // MANUAL MODE (FLEXIBLE)
//     // ─────────────────────────────
//     if (invoiceMode === "manual") {

//       const match = trimmedInvoiceNo.match(/-(\d+)N-/);
//       if (match) {
//         sequenceNumber = parseInt(match[1], 10);

//         // Optional smart catch-up
//         if (series.initialized && sequenceNumber > series.current_number) {
//           await supabase
//             .from("invoice_series")
//             .update({
//               current_number: sequenceNumber,
//             })
//             .eq("buyer_org_id", buyerId);
//         }

//         // First-time initialization
//         if (!series.initialized) {
//           await supabase
//             .from("invoice_series")
//             .update({
//               current_number: sequenceNumber,
//               initialized: true
//             })
//             .eq("buyer_org_id", buyerId);
//         }
//       }
//     }

//     // ─────────────────────────────
//     // GENERATE PDF
//     // ─────────────────────────────
//     const pdfBuffer = await generateInvoicePDF(data);

//     const fileName =
//       `invoices/${trimmedInvoiceNo.replace(/[^a-zA-Z0-9\-]/g, "_")}_${Date.now()}.pdf`;

//     const { error: uploadError } = await supabase.storage
//       .from("invoice-documents")
//       .upload(fileName, pdfBuffer, {
//         contentType: "application/pdf",
//         upsert: false
//       });

//     if (uploadError) {
//       console.error("Upload error:", uploadError);
//       return res.status(500).json({ error: "Failed to upload invoice PDF." });
//     }

//     const { data: urlData } = supabase.storage
//       .from("invoice-documents")
//       .getPublicUrl(fileName);

//     const downloadUrl = urlData?.publicUrl || null;

//     // ─────────────────────────────
//     // INSERT INTO consultancy_invoices
//     // ─────────────────────────────
//     const { data: record, error: dbError } = await supabase
//       .from("consultancy_invoices")
//       .insert({
//         buyer_org_id: buyerId,
//         invoice_number: trimmedInvoiceNo,
//         invoice_date: invoiceDate,
//         amount: totalAmount,
//         currency,
//         line_items: data.lineItems,
//         description: "Consultancy Services",
//         status: "issued",
//         sequence_number: sequenceNumber,
//         invoice_mode: invoiceMode,
//         pdf_path: fileName,
//         created_by: createdBy, // Ideally resolve member UUID
//         financial_year: series.financial_year,
//       })
//       .select()
//       .single();

//     if (dbError) {
//       console.error("DB insert error:", dbError);
//       return res.status(500).json({
//         error: "Invoice saved PDF but failed to store record.",
//         downloadUrl
//       });
//     }

//     // ─────────────────────────────
//     // INCREMENT SERIES (SYSTEM MODE ONLY)
//     // ─────────────────────────────
//     if (invoiceMode === "system") {
//       await supabase.rpc("increment_invoice_series", {
//         buyer_id: buyerId
//       });
//     }

//     return res.json({
//       success: true,
//       invoiceId: record.id,
//       downloadUrl,
//       message: "Invoice generated successfully."
//     });

//   } catch (error) {
//     console.error("Invoice generation error:", error);
//     return res.status(500).json({ error: "Internal server error." });
//   }
// });




// router.get('/next-invoice-number', async (req, res) => {
//   try {
//     const { buyerId } = req.query;
//     if (!buyerId) {
//       return res.status(400).json({ error: 'buyerId required' });
//     }

//     const { data: series, error } = await supabase
//       .from('invoice_series')
//       .select('*')
//       .eq('buyer_org_id', buyerId)
//       .maybeSingle();

//     if (error) throw error;

//     if (!series) {
//       return res.json({
//         initialized: false,
//         prefix: null
//       });
//     }

//     if (!series.initialized) {
//       return res.json({
//         initialized: false,
//         prefix: series.prefix,
//         financial_year: series.financial_year
//       });
//     }

//     const nextNumber = series.current_number + 1;

//     const padded = String(nextNumber).padStart(3, '0');

//     const invoiceNo = `${series.prefix}-${padded}N-${series.financial_year}`;

//     return res.json({
//       initialized: true,
//       invoiceNo,
//       prefix: series.prefix,          // ✅ add these two
//       financial_year: series.financial_year
//     });

//   } catch (err) {
//     console.error(err);
//     res.status(500).json({ error: 'Failed to fetch invoice series' });
//   }
// });
// module.exports = router