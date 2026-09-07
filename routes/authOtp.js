const express = require('express')
const rateLimit = require('express-rate-limit')
const { Resend } = require('resend')
const supabase = require('../supabaseClient')

const router = express.Router()
const resend = new Resend(process.env.RESEND_KEY)
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://plm.eai7.com'
const FROM_EMAIL = process.env.RESEND_FROM_EMAIL || 'hi@eai7.com'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

const sendOtpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 8,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) => {
    res.status(429).json({ error: 'Too many code requests. Please wait a few minutes and try again.' })
  },
})

async function findUserByEmail(email) {
  if (typeof supabase.auth.admin.getUserByEmail === 'function') {
    const { data, error } = await supabase.auth.admin.getUserByEmail(email)
    if (data?.user) return data.user
    if (error && !/not found|unable to find|user not found/i.test(error.message || '')) {
      console.warn('getUserByEmail:', error.message)
    }
  }
  return null
}

async function ensureUser(email, shouldCreateUser) {
  let user = await findUserByEmail(email)

  if (!user && shouldCreateUser) {
    const { data, error } = await supabase.auth.admin.createUser({
      email,
      email_confirm: true,
    })
    if (error && !/already been registered|already exists|already registered/i.test(error.message || '')) {
      throw error
    }
    user = data?.user || await findUserByEmail(email)
  }

  if (!user) {
    const err = new Error('No account found with that email. Try requesting access instead.')
    err.status = 404
    throw err
  }

  // Unconfirmed Auth users get a "Confirm signup" magic link (often localhost).
  // Confirm them first so we can issue a normal email OTP instead.
  if (!user.email_confirmed_at) {
    const { data, error } = await supabase.auth.admin.updateUserById(user.id, {
      email_confirm: true,
    })
    if (error) throw error
    user = data?.user || user
  }

  return user
}

function otpEmailHtml(otp) {
  const digits = String(otp).replace(/\D/g, '')
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0"/></head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:Georgia,serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="padding:40px 16px;">
    <tr><td align="center">
      <table width="100%" cellpadding="0" cellspacing="0" style="max-width:440px;background:#fff;border-radius:16px;padding:36px 28px;">
        <tr><td align="center" style="font-size:13px;letter-spacing:0.18em;text-transform:uppercase;color:#4d68f0;font-weight:700;font-family:system-ui,sans-serif;">
          Twif
        </td></tr>
        <tr><td align="center" style="padding:18px 0 8px;font-size:20px;color:#111;font-weight:400;">
          Your verification code
        </td></tr>
        <tr><td align="center" style="padding:8px 0 24px;font-size:14px;color:#64748b;line-height:1.5;">
          Enter this code in the Twif sign-up screen. It expires in 1 hour.
        </td></tr>
        <tr><td align="center" style="padding:8px 0 24px;">
          <div style="font-family:'Courier New',monospace;font-size:32px;letter-spacing:0.28em;font-weight:700;color:#0f172a;">
            ${digits}
          </div>
        </td></tr>
        <tr><td align="center" style="font-size:12px;color:#94a3b8;line-height:1.5;">
          If you did not request this, you can ignore this email.
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`
}

router.post('/send-otp', sendOtpLimiter, async (req, res) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase()
    const shouldCreateUser = Boolean(req.body?.shouldCreateUser)
    if (!email || !EMAIL_RE.test(email)) {
      return res.status(400).json({ error: 'A valid email is required' })
    }

    await ensureUser(email, shouldCreateUser)

    const redirectTo = `${FRONTEND_URL.replace(/\/$/, '')}/auth`
    let { data, error } = await supabase.auth.admin.generateLink({
      type: 'magiclink',
      email,
      options: { redirectTo },
    })
    if (error && /not found|unable to find/i.test(error.message || '')) {
      if (!shouldCreateUser) {
        const notFound = new Error('No account found with that email. Try requesting access instead.')
        notFound.status = 404
        throw notFound
      }
      await ensureUser(email, true)
      ;({ data, error } = await supabase.auth.admin.generateLink({
        type: 'magiclink',
        email,
        options: { redirectTo },
      }))
    }
    if (error) throw error

    const otp = data?.properties?.email_otp
    if (!otp) throw new Error('Could not generate a verification code. Please try again.')

    const { error: mailError } = await resend.emails.send({
      from: FROM_EMAIL,
      to: email,
      subject: 'Your Twif verification code',
      html: otpEmailHtml(otp),
      text: `Your Twif verification code is ${otp}. Enter it in the sign-up screen. It expires in 1 hour.`,
    })
    if (mailError) throw mailError

    return res.json({ success: true })
  } catch (err) {
    const status = err.status || 500
    if (status === 404) return res.status(404).json({ error: err.message })
    console.error('POST /auth/send-otp:', err.message)
    return res.status(500).json({ error: 'Could not send the verification code. Please try again.' })
  }
})

module.exports = router
