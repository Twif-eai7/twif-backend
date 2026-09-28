const express = require('express');
const router = express.Router();
const { OAuth2Client } = require('google-auth-library');
const { Resend } = require('resend');
const { resolveEmailAttachment } = require('../service/emailAttachments');

const resend = new Resend(process.env.RESEND_KEY);
const authClient = new OAuth2Client();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Same cap sendAlertEmail's own local-dev combinedTo path uses - Resend
// limits how many addresses can go in one message's `to`.
const MAX_COMBINED_TO = 45;
function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function verifyCloudTasksRequest(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) return res.sendStatus(401);

  try {
    await authClient.verifyIdToken({
      idToken: authHeader.slice(7),
      audience: process.env.CLOUD_RUN_URL,
    });
    next();
  } catch {
    res.sendStatus(401);
  }
}

// Cloud Tasks calls this at ≤4/sec — one task = one batch of recipients.
// 2xx → task done. 5xx → Cloud Tasks retries with its own exponential backoff.
router.post('/send-email', verifyCloudTasksRequest, async (req, res) => {
  const { recipients, subject, html, attachment, combinedTo } = req.body;

  if (!recipients?.length || !subject || !html) {
    // 4xx = permanent failure, Cloud Tasks will NOT retry
    return res.status(400).json({ error: 'Missing required fields: recipients, subject, html' });
  }

  const pdfAttachment = attachment ? await resolveEmailAttachment(attachment) : null;

  // combinedTo: everyone together in one email's `to`, so a Reply-All
  // reaches the whole group - opt-in only (inspection Send Mail/callout
  // notifications), every other alert type still isolates recipients
  // below. Chunked defensively past Resend's own `to` cap.
  if (combinedTo) {
    const chunks = chunk(recipients, MAX_COMBINED_TO);
    for (let attempt = 0; attempt < 2; attempt++) {
      const failed = [];
      for (const c of chunks) {
        const { error } = await resend.emails.send({
          from: process.env.RESEND_FROM_EMAIL || 'hi@eai7.com',
          to: c,
          subject,
          html,
          ...(pdfAttachment ? { attachments: [pdfAttachment] } : {}),
        });
        if (error) failed.push({ emails: c, error });
      }

      if (!failed.length) {
        console.log(`✅ Combined email sent to ${recipients.length} recipient(s) together:`, recipients);
        return res.sendStatus(200);
      }

      const isRateLimit = failed.some(({ error }) =>
        error.statusCode === 429 || (typeof error.message === 'string' && error.message.toLowerCase().includes('rate'))
      );

      if (isRateLimit && attempt === 0) {
        console.warn(`⏳ Rate limit on combined send - waiting 1s before retry`);
        await sleep(1000);
        continue;
      }

      console.error(`❌ Combined send failed for [${failed.flatMap((f) => f.emails).join(', ')}]`);
      return res.status(500).json({ error: failed[0].error.message });
    }
    return;
  }

  // Resend's batch.send API doesn't support attachments, only the
  // single-recipient emails.send does - so a resolved attachment forces a
  // per-recipient loop, isolated in their own `to: [email]` just like
  // batch.send already keeps recipients from seeing each other's address.
  if (pdfAttachment) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const failed = [];
      for (const email of recipients) {
        const { error } = await resend.emails.send({
          from: process.env.RESEND_FROM_EMAIL || 'hi@eai7.com',
          to: [email],
          subject,
          html,
          attachments: [pdfAttachment],
        });
        if (error) failed.push({ email, error });
      }

      if (!failed.length) {
        console.log(`✅ Attached email sent to ${recipients.length} recipient(s):`, recipients);
        return res.sendStatus(200);
      }

      const isRateLimit = failed.some(({ error }) =>
        error.statusCode === 429 || (typeof error.message === 'string' && error.message.toLowerCase().includes('rate'))
      );

      if (isRateLimit && attempt === 0) {
        console.warn(`⏳ Rate limit on attached send - waiting 1s before retry`);
        await sleep(1000);
        continue;
      }

      console.error(`❌ Attached send failed for [${failed.map((f) => f.email).join(', ')}]`);
      return res.status(500).json({ error: failed[0].error.message });
    }
    return;
  }

  const batchEmails = recipients.map((email) => ({
    from: process.env.RESEND_FROM_EMAIL || 'hi@eai7.com',
    to: [email],
    subject,
    html,
  }));

  // One retry on rate-limit — Cloud Tasks outer retry handles persistent failures
  for (let attempt = 0; attempt < 2; attempt++) {
    const { data, error } = await resend.batch.send(batchEmails);

    if (!error) {
      console.log(`✅ Batch sent to ${recipients.length} recipient(s):`, recipients);
      return res.sendStatus(200);
    }

    const isRateLimit =
      error.statusCode === 429 ||
      (typeof error.message === 'string' && error.message.toLowerCase().includes('rate'));

    if (isRateLimit && attempt === 0) {
      console.warn(`⏳ Rate limit on batch send — waiting 1s before retry`);
      await sleep(1000);
      continue;
    }

    console.error(`❌ Batch send failed for [${recipients.join(', ')}]:`, error.message);
    // 5xx → Cloud Tasks will re-enqueue this task with backoff
    return res.status(500).json({ error: error.message });
  }
});

module.exports = router;
