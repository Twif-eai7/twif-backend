const express = require('express');
const router = express.Router();
const { OAuth2Client } = require('google-auth-library');
const { Resend } = require('resend');

const resend = new Resend(process.env.RESEND_KEY);
const authClient = new OAuth2Client();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  const { recipients, subject, html } = req.body;

  if (!recipients?.length || !subject || !html) {
    // 4xx = permanent failure, Cloud Tasks will NOT retry
    return res.status(400).json({ error: 'Missing required fields: recipients, subject, html' });
  }

  const batchEmails = recipients.map((email) => ({
    from: 'care@jnitin.com',
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
