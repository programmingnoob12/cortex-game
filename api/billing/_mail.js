// api/billing/_mail.js
//
// Plain SMTP through the Gmail app password already created for Supabase.
// Nothing here is allowed to break a billing action — every caller wraps
// this in try/catch, because failing to send a notification email must
// never stop someone's cancellation from going through.

import nodemailer from "nodemailer";

// Deliberately NOT cached in module scope. Vercel keeps a warm container
// between invocations, and Gmail closes idle SMTP connections — a reused
// transporter throws on the second send even though the first succeeded.
// A fresh, unpooled connection per email costs a few hundred ms and is
// reliable.
function makeTransporter() {
  const user = process.env.GMAIL_USER;
  const pass = process.env.GMAIL_APP_PASSWORD;
  if (!user || !pass) return null;

  return nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 465,
    secure: true,
    pool: false,
    auth: { user, pass },
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 15000,
  });
}

export async function sendCancellationEmail({ customerEmail, feedback, comment, subscriptionId }) {
  const tx = makeTransporter();
  if (!tx) {
    console.warn("cancellation email skipped — GMAIL_USER/GMAIL_APP_PASSWORD not set");
    return;
  }

  const to = process.env.FEEDBACK_TO_EMAIL || process.env.GMAIL_USER;

  // Stripe's feedback values are terse enums; spell them out so the email
  // reads as a sentence rather than a database value.
  const REASONS = {
    customer_service: "Unhappy with customer service",
    low_quality: "Quality was less than expected",
    missing_features: "Missing features they needed",
    other: "Other",
    switched_service: "Switched to another service",
    too_complex: "Too complicated to use",
    too_expensive: "Too expensive",
    unused: "Wasn't using it enough",
  };

  const reason = REASONS[feedback] || feedback || "No reason given";
  const note = comment?.trim() || "(no comment left)";

  try {
    await tx.sendMail({
    from: `"Cortex" <${process.env.GMAIL_USER}>`,
    to,
    replyTo: customerEmail || undefined,
    // Gmail threads by subject line, so two cancellations with the same
    // reason would collapse into one conversation and the second looks
    // like it never arrived. The timestamp keeps every one distinct.
    subject: `Cancellation — ${reason} — ${customerEmail || "unknown"} — ${new Date()
      .toISOString()
      .slice(0, 16)
      .replace("T", " ")}`,
    text: [
      `Someone cancelled their Cortex membership.`,
      ``,
      `Customer:     ${customerEmail || "unknown"}`,
      `Reason:       ${reason}`,
      `Comment:      ${note}`,
      `Subscription: ${subscriptionId}`,
      ``,
      `They keep access until the end of the current billing period.`,
    ].join("\n"),
    });
  } finally {
    // Always tear the connection down so nothing stale is left behind for
    // the next invocation on this warm container.
    tx.close();
  }
}
