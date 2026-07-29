// routes/shareList.js
const express = require('express');
const puppeteer = require('puppeteer');
const nodemailer = require('nodemailer');
const router = express.Router();

// Helper to generate HTML (copy your printList HTML template here)
function createPrintHtml(listName, products) {
  // Paste the inner HTML string from your printList() function here,
  // replacing `${listName}` and `${tableRows}` logic with actual loops.
  // E.g.:
  let rows = products.map((product, i) => `
    <tr> … your cells with product.title, product.featured_image, etc. … </tr>
  `).join('');
  return `
    <!DOCTYPE html><html><head>…styles…</head><body>
      <h1>${listName}</h1>
      <table><tbody>${rows}</tbody></table>
      … rest of footer …
    </body></html>
  `;
}

router.post('/', async (req, res) => {
  const { listName, products, toEmail } = req.body;
  if (!listName || !Array.isArray(products) || !toEmail) {
    return res.status(400).json({ error: 'Missing listName, products array, or toEmail' });
  }

  try {
    // 1. Render PDF with Puppeteer
    const browser = await puppeteer.launch({ headless: true });
    const page = await browser.newPage();
    const html = createPrintHtml(listName, products);
    await page.setContent(html, { waitUntil: 'networkidle0' });
    const pdfBuffer = await page.pdf({ format: 'A4', printBackground: true });
    await browser.close();

    // 2. Send email with PDF attachment
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: +process.env.SMTP_PORT,
      secure: process.env.SMTP_SECURE === 'true',
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS
      }
    });

    await transporter.sendMail({
      from: `"Your Shop" <${process.env.SMTP_FROM}>`,
      to: toEmail,
      subject: `Your Product List: ${listName}`,
      text: `Attached is your product list "${listName}".`,
      attachments: [{
        filename: `${listName}.pdf`,
        content: pdfBuffer
      }]
    });

    return res.json({ success: true });
  } catch (err) {
    console.error('Share-list error:', err);
    return res.status(500).json({ error: 'Failed to generate or send PDF' });
  }
});

module.exports = router;
