import nodemailer, { Transporter } from 'nodemailer';

export interface SendVerificationEmailParams {
  to: string;
  name: string;
  otp: string;
}

export interface SendPasswordResetEmailParams {
  to: string;
  name: string;
  otp: string;
}

/**
 * Returns a configured Nodemailer transporter or null if SMTP is unconfigured.
 * Uses non-pooled connections with explicit timeouts for serverless compatibility.
 */
function getTransporter(): Transporter | null {
  const host = process.env.SMTP_HOST?.trim();
  const user = process.env.SMTP_USER?.trim();
  const pass = process.env.SMTP_PASS?.trim();

  const missing: string[] = [];
  if (!host) missing.push('SMTP_HOST');
  if (!user) missing.push('SMTP_USER');
  if (!pass) missing.push('SMTP_PASS');

  if (missing.length > 0) {
    console.error('[EmailService] Missing SMTP env vars:', missing);
    return null;
  }

  const parsedPort = parseInt(process.env.SMTP_PORT?.trim() || '587', 10);
  const port = Number.isFinite(parsedPort) && parsedPort > 0 ? parsedPort : 587;
  const secure =
    port === 465
      ? true
      : port === 587
        ? false
        : process.env.SMTP_SECURE?.trim() === 'true' || process.env.SMTP_SECURE?.trim() === '1';

  return nodemailer.createTransport({
    host,
    port,
    secure,
    auth: { user, pass },
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 15000,
  });
}

function getFromAddress(): string {
  return (
    process.env.EMAIL_FROM?.trim() ||
    'PugArch Project Management <no-reply@pugarch.internal>'
  );
}

function getAppTimeZone(): string {
  return process.env.APP_TIMEZONE?.trim() || 'Asia/Kolkata';
}

/**
 * Sends an email via Nodemailer with structured success/error logging.
 * Never throws; returns true on delivery and false otherwise.
 */
async function deliverMail(params: {
  to: string;
  subject: string;
  text: string;
  html: string;
}): Promise<{ delivered: boolean; unconfigured?: boolean }> {
  const transporter = getTransporter();
  if (!transporter) {
    return { delivered: false, unconfigured: true };
  }

  const from = getFromAddress();
  try {
    const info = await transporter.sendMail({
      from,
      to: params.to,
      subject: params.subject,
      text: params.text,
      html: params.html,
    });
    console.info('[EmailService] Sent:', {
      to: params.to,
      subject: params.subject,
      messageId: info.messageId,
    });
    return { delivered: true };
  } catch (err: any) {
    console.error('[EmailService] Failed:', {
      to: params.to,
      subject: params.subject,
      code: err?.code,
      responseCode: err?.responseCode,
      command: err?.command,
      message: err?.message,
    });
    return { delivered: false };
  }
}

/**
 * Dispatches an account verification OTP email with professional HTML and plain-text fallback.
 */
export async function sendVerificationOtpEmail(
  params: SendVerificationEmailParams
): Promise<{ delivered: boolean; mockLogged?: boolean }> {
  const { to, name, otp } = params;
  const from = getFromAddress();
  const transporter = getTransporter();

  const subject = `${otp} is your PugArch account verification code`;

  const text = `
Hello ${name || 'Team Member'},

Your 6-digit identity verification code is: ${otp}

This code will expire in 5 minutes.

To complete your account registration, enter this verification code on the PugArch activation screen.

If you did not request this verification code, please ignore this email or notify your system administrator.

—
PugArch Projects Cloud
Enterprise Architecture & Access Control
`.trim();

  const html = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Account Verification Code</title>
</head>
<body style="margin: 0; padding: 0; background-color: #FBF9F4; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #231E1B;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color: #FBF9F4; padding: 40px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" style="max-width: 540px; background-color: #FFFFFF; border: 1px solid #E8E2D5; border-radius: 20px; overflow: hidden; box-shadow: 0 4px 20px rgba(35, 30, 27, 0.05);">
          <!-- Brand Header -->
          <tr>
            <td style="background-color: #231E1B; padding: 28px 32px; text-align: left;">
              <span style="font-family: Georgia, serif; font-size: 20px; font-weight: bold; color: #FFFFFF; letter-spacing: 0.5px;">
                PugArch &mdash; <span style="color: #E28C68;">Projects</span>
              </span>
              <div style="font-size: 11px; color: #A49C90; margin-top: 4px; text-transform: uppercase; letter-spacing: 1px;">
                Enterprise Identity Verification
              </div>
            </td>
          </tr>

          <!-- Main Content -->
          <tr>
            <td style="padding: 36px 32px;">
              <h1 style="font-size: 18px; font-weight: 700; color: #231E1B; margin: 0 0 16px 0; letter-spacing: -0.2px;">
                Verify Your Pre-Registered Account
              </h1>
              <p style="font-size: 14px; line-height: 22px; color: #5A524A; margin: 0 0 24px 0;">
                Hello <strong>${name || 'Team Member'}</strong>,<br>
                Your organization has pre-registered your work account. Use the one-time verification code below to verify your identity and set up your workspace password.
              </p>

              <!-- OTP Callout Box -->
              <div style="background-color: #FAF7F0; border: 1px solid #DDD6C8; border-radius: 14px; padding: 20px 24px; text-align: center; margin: 24px 0;">
                <div style="font-size: 11px; font-weight: 600; text-transform: uppercase; color: #70685F; letter-spacing: 1.5px; margin-bottom: 8px;">
                  Your 6-Digit Verification Code
                </div>
                <div style="font-family: 'Courier New', Courier, monospace; font-size: 36px; font-weight: 800; letter-spacing: 8px; color: #C85A32; line-height: 1.2;">
                  ${otp}
                </div>
                <div style="font-size: 11px; color: #8F867A; margin-top: 8px;">
                  &bull; Valid for <strong>5 minutes</strong> &bull;
                </div>
              </div>

              <!-- Security Information -->
              <p style="font-size: 12px; line-height: 18px; color: #70685F; margin: 0 0 16px 0;">
                Enter this code on the activation screen to complete verification. For security purposes, this code is strictly single-use and will expire in 5 minutes.
              </p>
              <p style="font-size: 11px; line-height: 16px; color: #A49C90; margin: 0;">
                If you did not request this verification code, please ignore this email or alert your system administrator immediately.
              </p>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="background-color: #F8F5EE; padding: 20px 32px; border-top: 1px solid #EDE7DC; text-align: center;">
              <p style="font-size: 11px; color: #8F867A; margin: 0;">
                End-to-End Enterprise Access Control &bull; PugArch Cloud
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
`.trim();

  const result = await deliverMail({ to, subject, text, html });
  if (result.delivered) {
    return { delivered: true };
  }
  if (result.unconfigured && process.env.NODE_ENV !== 'production') {
    console.log(`\n======================================================`);
    console.log(`[EmailService DEV] Simulated verification email to: ${to}`);
    console.log(`[EmailService DEV] OTP Code: ${otp} (Expires in 5 minutes)`);
    console.log(`======================================================\n`);
    return { delivered: true, mockLogged: true };
  }
  return { delivered: false };
}

/**
 * Dispatches a password recovery OTP email with professional HTML and plain-text fallback.
 */
export async function sendPasswordResetOtpEmail(
  params: SendPasswordResetEmailParams
): Promise<{ delivered: boolean; mockLogged?: boolean }> {
  const { to, name, otp } = params;
  const from = getFromAddress();
  const transporter = getTransporter();

  const subject = `${otp} is your PugArch password recovery code`;

  const text = `
Hello ${name || 'Team Member'},

Your 6-digit password recovery code is: ${otp}

This code will expire in 5 minutes.

Use this code on the password reset screen to securely create a new password.

If you did not request a password recovery code, please notify your administrator immediately.

—
PugArch Projects Cloud
Enterprise Architecture & Access Control
`.trim();

  const html = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Password Recovery Code</title>
</head>
<body style="margin: 0; padding: 0; background-color: #FBF9F4; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #231E1B;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color: #FBF9F4; padding: 40px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" style="max-width: 540px; background-color: #FFFFFF; border: 1px solid #E8E2D5; border-radius: 20px; overflow: hidden; box-shadow: 0 4px 20px rgba(35, 30, 27, 0.05);">
          <!-- Brand Header -->
          <tr>
            <td style="background-color: #231E1B; padding: 28px 32px; text-align: left;">
              <span style="font-family: Georgia, serif; font-size: 20px; font-weight: bold; color: #FFFFFF; letter-spacing: 0.5px;">
                PugArch &mdash; <span style="color: #E28C68;">Projects</span>
              </span>
              <div style="font-size: 11px; color: #A49C90; margin-top: 4px; text-transform: uppercase; letter-spacing: 1px;">
                Password Recovery Authorization
              </div>
            </td>
          </tr>

          <!-- Main Content -->
          <tr>
            <td style="padding: 36px 32px;">
              <h1 style="font-size: 18px; font-weight: 700; color: #231E1B; margin: 0 0 16px 0; letter-spacing: -0.2px;">
                Reset Your Workspace Password
              </h1>
              <p style="font-size: 14px; line-height: 22px; color: #5A524A; margin: 0 0 24px 0;">
                Hello <strong>${name || 'Team Member'}</strong>,<br>
                We received a request to reset your password. Use the 6-digit recovery code below to proceed.
              </p>

              <!-- OTP Callout Box -->
              <div style="background-color: #FAF7F0; border: 1px solid #DDD6C8; border-radius: 14px; padding: 20px 24px; text-align: center; margin: 24px 0;">
                <div style="font-size: 11px; font-weight: 600; text-transform: uppercase; color: #70685F; letter-spacing: 1.5px; margin-bottom: 8px;">
                  Your 6-Digit Recovery Code
                </div>
                <div style="font-family: 'Courier New', Courier, monospace; font-size: 36px; font-weight: 800; letter-spacing: 8px; color: #C85A32; line-height: 1.2;">
                  ${otp}
                </div>
                <div style="font-size: 11px; color: #8F867A; margin-top: 8px;">
                  &bull; Valid for <strong>5 minutes</strong> &bull;
                </div>
              </div>

              <p style="font-size: 12px; line-height: 18px; color: #70685F; margin: 0 0 16px 0;">
                For your security, this recovery code is strictly single-use and will expire in 5 minutes.
              </p>
              <p style="font-size: 11px; line-height: 16px; color: #A49C90; margin: 0;">
                If you did not request this recovery code, someone may have entered your identifier by mistake. No changes have been made to your account.
              </p>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="background-color: #F8F5EE; padding: 20px 32px; border-top: 1px solid #EDE7DC; text-align: center;">
              <p style="font-size: 11px; color: #8F867A; margin: 0;">
                End-to-End Enterprise Access Control &bull; PugArch Cloud
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
`.trim();

  const result = await deliverMail({ to, subject, text, html });
  if (result.delivered) {
    return { delivered: true };
  }
  if (result.unconfigured && process.env.NODE_ENV !== 'production') {
    console.log(`\n======================================================`);
    console.log(`[EmailService DEV] Simulated password recovery email to: ${to}`);
    console.log(`[EmailService DEV] Recovery Code: ${otp} (Expires in 5 minutes)`);
    console.log(`======================================================\n`);
    return { delivered: true, mockLogged: true };
  }
  return { delivered: false };
}

export interface SendPreRegistrationEmailParams {
  to: string;
  name: string;
  phone: string;
  role?: string;
  department?: string;
  portalUrl?: string;
}

/**
 * Intelligently resolves the portal URL:
 * - When called from a live frontend domain, uses the live domain.
 * - When called locally (localhost / 127.0.0.1 / local network), uses the local address.
 * - In production environments (Vercel / production server), falls back to the live portal URL.
 */
export function resolvePortalUrl(req?: any, bodyPortalUrl?: string): string {
  // 1. Explicitly provided from browser client window.location.origin
  if (bodyPortalUrl && typeof bodyPortalUrl === 'string' && bodyPortalUrl.startsWith('http')) {
    return bodyPortalUrl.trim().replace(/\/+$/, '');
  }

  // 2. Request Origin header
  const origin = req?.get?.('origin') || req?.headers?.origin;
  if (origin && typeof origin === 'string' && origin.startsWith('http') && !origin.includes('null')) {
    return origin.trim().replace(/\/+$/, '');
  }

  // 3. Request Referer header (parse origin from referer)
  const referer = req?.get?.('referer') || req?.headers?.referer;
  if (referer && typeof referer === 'string' && referer.startsWith('http')) {
    try {
      const url = new URL(referer);
      return url.origin;
    } catch {}
  }

  // 4. In production, check APP_URL / FRONTEND_URL if not localhost
  const envAppUrl = (process.env.APP_URL || process.env.FRONTEND_URL || '').trim().replace(/\/+$/, '');
  if (envAppUrl && !envAppUrl.includes('localhost') && !envAppUrl.includes('127.0.0.1')) {
    return envAppUrl;
  }

  // 5. If running in production or on Vercel, default to live production link
  if (process.env.VERCEL || process.env.NODE_ENV === 'production') {
    return 'https://pm-frontend-rouge.vercel.app';
  }

  // 6. Local development fallback
  return envAppUrl || 'http://localhost:3000';
}

/**
 * Dispatches an account pre-registration invitation email to a newly added user.
 * Provides their pre-registered details and a direct activation link to the portal signup page.
 */
export async function sendPreRegistrationEmail(
  params: SendPreRegistrationEmailParams
): Promise<{ delivered: boolean; mockLogged?: boolean }> {
  const { to, name, phone, role, department, portalUrl } = params;
  const from = getFromAddress();
  const transporter = getTransporter();

  const baseUrl = resolvePortalUrl(undefined, portalUrl);
  const signupLink = `${baseUrl}/signup?email=${encodeURIComponent(to)}&phone=${encodeURIComponent(phone)}`;

  const subject = `Welcome to PugArch — You have been registered on the workspace portal`;

  const text = `
Hello ${name || 'Team Member'},

Your organization has registered your account on the PugArch Projects portal.

Your Pre-Registered Details:
• Portal: PugArch Projects
• Assigned Role: ${role || 'Employee'}
• Department: ${department || 'Operations'}
• Pre-Registered Email: ${to}
• Pre-Registered Mobile: ${phone}

To complete your account registration and set up your password, visit the portal link below:
${signupLink}

Follow the on-screen steps to verify your identity with a one-time verification code and activate your account.

—
PugArch Projects Cloud
Enterprise Architecture & Access Control
`.trim();

  const html = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Welcome to PugArch</title>
</head>
<body style="margin: 0; padding: 0; background-color: #FBF9F4; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #231E1B;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color: #FBF9F4; padding: 40px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" style="max-width: 560px; background-color: #FFFFFF; border: 1px solid #E8E2D5; border-radius: 20px; overflow: hidden; box-shadow: 0 4px 20px rgba(35, 30, 27, 0.05);">
          <!-- Brand Header -->
          <tr>
            <td style="background-color: #231E1B; padding: 28px 32px; text-align: left;">
              <span style="font-family: Georgia, serif; font-size: 22px; font-weight: bold; color: #FFFFFF; letter-spacing: 0.5px;">
                PugArch &mdash; <span style="color: #E28C68;">Projects</span>
              </span>
              <div style="font-size: 11px; color: #A49C90; margin-top: 4px; text-transform: uppercase; letter-spacing: 1px;">
                Enterprise Workspace Invitation
              </div>
            </td>
          </tr>

          <!-- Main Content -->
          <tr>
            <td style="padding: 36px 32px;">
              <h1 style="font-size: 20px; font-weight: 700; color: #231E1B; margin: 0 0 16px 0; letter-spacing: -0.3px;">
                Welcome to PugArch, ${name || 'Team Member'}!
              </h1>
              <p style="font-size: 14px; line-height: 22px; color: #5A524A; margin: 0 0 24px 0;">
                Your organization has pre-registered your work account on the <strong>PugArch Projects</strong> portal. You can now complete your activation and set up your workspace password.
              </p>

              <!-- Account Details Card -->
              <div style="background-color: #FAF7F0; border: 1px solid #DDD6C8; border-radius: 14px; padding: 20px 24px; margin: 24px 0;">
                <div style="font-size: 11px; font-weight: 700; text-transform: uppercase; color: #70685F; letter-spacing: 1.2px; margin-bottom: 14px; border-bottom: 1px solid #E8E2D5; padding-bottom: 8px;">
                  Your Pre-Registered Details
                </div>
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="font-size: 13px; line-height: 22px;">
                  <tr>
                    <td style="color: #8F867A; width: 140px; padding: 4px 0;">Assigned Role:</td>
                    <td style="color: #231E1B; font-weight: 600; padding: 4px 0;">${role || 'Employee'}</td>
                  </tr>
                  <tr>
                    <td style="color: #8F867A; padding: 4px 0;">Department:</td>
                    <td style="color: #231E1B; font-weight: 600; padding: 4px 0;">${department || 'Operations'}</td>
                  </tr>
                  <tr>
                    <td style="color: #8F867A; padding: 4px 0;">Registered Email:</td>
                    <td style="color: #231E1B; font-weight: 600; padding: 4px 0;">${to}</td>
                  </tr>
                  <tr>
                    <td style="color: #8F867A; padding: 4px 0;">Registered Phone:</td>
                    <td style="color: #231E1B; font-weight: 600; padding: 4px 0;">${phone}</td>
                  </tr>
                </table>
              </div>

              <!-- CTA Button -->
              <div style="text-align: center; margin: 32px 0 24px 0;">
                <a href="${signupLink}" target="_blank" style="display: inline-block; background-color: #C85A32; color: #FFFFFF; font-size: 14px; font-weight: 600; text-decoration: none; padding: 14px 32px; border-radius: 12px; box-shadow: 0 4px 12px rgba(200, 90, 50, 0.25);">
                  Activate Account &amp; Set Password &rarr;
                </a>
              </div>

              <div style="background-color: #F8F5EE; border-radius: 10px; padding: 12px 16px; margin-top: 20px; font-size: 12px; color: #70685F; line-height: 18px;">
                <strong>Next Step:</strong> When prompted on the activation screen, verify your email with a one-time security code to finalize your password.
              </div>

              <p style="font-size: 11px; line-height: 16px; color: #A49C90; margin: 24px 0 0 0; word-break: break-all;">
                Direct Link: <a href="${signupLink}" style="color: #C85A32; text-decoration: underline;">${signupLink}</a>
              </p>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="background-color: #F8F5EE; padding: 20px 32px; border-top: 1px solid #EDE7DC; text-align: center;">
              <p style="font-size: 11px; color: #8F867A; margin: 0;">
                End-to-End Enterprise Access Control &bull; PugArch Projects Cloud
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
`.trim();

  const result = await deliverMail({ to, subject, text, html });
  if (result.delivered) {
    return { delivered: true };
  }
  if (result.unconfigured && process.env.NODE_ENV !== 'production') {
    console.log(`\n======================================================`);
    console.log(`[EmailService DEV] Simulated pre-registration email to: ${to}`);
    console.log(`[EmailService DEV] Signup URL: ${signupLink}`);
    console.log(`======================================================\n`);
    return { delivered: true, mockLogged: true };
  }
  return { delivered: false };
}

export interface SendLeaveRequestEmailParams {
  to: string;
  recipientName: string;
  recipientRole?: string;
  requesterName: string;
  requesterRole: string;
  leaveType: string;
  dayType: string;
  startDate: string;
  endDate: string;
  submissionDate: string;
  status: string;
  viewLink: string;
}

/**
 * Dispatches a leave request email notification to an authorized recipient.
 * Includes requester details, dates, leave type, status, and portal review link.
 * Omit personal reasons to protect employee confidentiality.
 */
export async function sendLeaveRequestEmail(
  params: SendLeaveRequestEmailParams
): Promise<{ delivered: boolean; mockLogged?: boolean }> {
  const {
    to,
    recipientName,
    requesterName,
    requesterRole,
    leaveType,
    dayType,
    startDate,
    endDate,
    submissionDate,
    status,
    viewLink,
  } = params;

  const from = getFromAddress();
  const transporter = getTransporter();

  const subject = `[PugArch] New Leave Request Submitted: ${requesterName} (${leaveType})`;

  const text = `
Hello ${recipientName || 'Team Leader'},

A new leave request has been submitted by ${requesterName} (${requesterRole}) and is pending review.

Request Details:
- Requester: ${requesterName} (${requesterRole})
- Leave Type: ${leaveType} (${dayType})
- Dates: ${startDate}${endDate && endDate !== startDate ? ` – ${endDate}` : ''}
- Submitted: ${submissionDate}
- Approval Status: ${status}

Review this request in your dashboard:
${viewLink}

—
PugArch Cloud Operations
Organizational Hierarchy & Leave Management
`.trim();

  const html = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>New Leave Request Submitted</title>
</head>
<body style="margin: 0; padding: 0; background-color: #FBF9F4; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #231E1B;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color: #FBF9F4; padding: 40px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" style="max-width: 560px; background-color: #FFFFFF; border: 1px solid #E8E2D5; border-radius: 20px; overflow: hidden; box-shadow: 0 4px 20px rgba(35, 30, 27, 0.05);">
          <!-- Brand Header -->
          <tr>
            <td style="background-color: #231E1B; padding: 26px 32px; text-align: left;">
              <span style="font-family: Georgia, serif; font-size: 20px; font-weight: bold; color: #FFFFFF; letter-spacing: 0.5px;">
                PugArch &mdash; <span style="color: #E28C68;">Operations</span>
              </span>
              <div style="font-size: 11px; color: #A49C90; margin-top: 4px; text-transform: uppercase; letter-spacing: 1px;">
                Leave Management Notification
              </div>
            </td>
          </tr>

          <!-- Main Content -->
          <tr>
            <td style="padding: 32px 32px 24px 32px;">
              <h1 style="font-size: 18px; font-weight: 700; color: #231E1B; margin: 0 0 12px 0; letter-spacing: -0.2px;">
                New Leave Request Pending Review
              </h1>
              <p style="font-size: 14px; line-height: 22px; color: #5A524A; margin: 0 0 20px 0;">
                Hello <strong>${recipientName || 'Team Leader'}</strong>,<br>
                A new leave request has been submitted by <strong>${requesterName}</strong> (${requesterRole}) and is awaiting review in accordance with organizational hierarchy rules.
              </p>

              <!-- Leave Details Box -->
              <table role="presentation" width="100%" style="background-color: #FAF7F0; border: 1px solid #DDD6C8; border-radius: 14px; margin: 20px 0; border-collapse: separate; border-spacing: 0;">
                <tr>
                  <td style="padding: 12px 16px; border-bottom: 1px solid #E8E2D5; font-size: 12px; color: #70685F; width: 36%; font-weight: 600;">
                    Requester:
                  </td>
                  <td style="padding: 12px 16px; border-bottom: 1px solid #E8E2D5; font-size: 13px; color: #231E1B; font-weight: bold;">
                    ${requesterName} <span style="font-size: 11px; color: #70685F; font-weight: normal;">(${requesterRole})</span>
                  </td>
                </tr>
                <tr>
                  <td style="padding: 12px 16px; border-bottom: 1px solid #E8E2D5; font-size: 12px; color: #70685F; font-weight: 600;">
                    Leave Type:
                  </td>
                  <td style="padding: 12px 16px; border-bottom: 1px solid #E8E2D5; font-size: 13px; color: #231E1B; font-weight: 600;">
                    ${leaveType} <span style="font-size: 11px; color: #70685F; font-weight: normal;">&bull; ${dayType}</span>
                  </td>
                </tr>
                <tr>
                  <td style="padding: 12px 16px; border-bottom: 1px solid #E8E2D5; font-size: 12px; color: #70685F; font-weight: 600;">
                    Requested Dates:
                  </td>
                  <td style="padding: 12px 16px; border-bottom: 1px solid #E8E2D5; font-size: 13px; color: #231E1B;">
                    <strong>${startDate}</strong>${endDate && endDate !== startDate ? ` &ndash; <strong>${endDate}</strong>` : ''}
                  </td>
                </tr>
                <tr>
                  <td style="padding: 12px 16px; border-bottom: 1px solid #E8E2D5; font-size: 12px; color: #70685F; font-weight: 600;">
                    Submitted:
                  </td>
                  <td style="padding: 12px 16px; border-bottom: 1px solid #E8E2D5; font-size: 12px; color: #5A524A;">
                    ${submissionDate}
                  </td>
                </tr>
                <tr>
                  <td style="padding: 12px 16px; font-size: 12px; color: #70685F; font-weight: 600;">
                    Approval Status:
                  </td>
                  <td style="padding: 12px 16px; font-size: 12px;">
                    <span style="display: inline-block; padding: 3px 10px; border-radius: 12px; font-weight: 700; font-size: 11px; background-color: #F2EDE2; color: #70685F; border: 1px solid #DDD6C8;">
                      ${status}
                    </span>
                  </td>
                </tr>
              </table>

              <!-- Call to Action Button -->
              <div style="text-align: center; margin: 26px 0 16px 0;">
                <a href="${viewLink}" style="display: inline-block; background-color: #C85A32; color: #FFFFFF; text-decoration: none; font-size: 13px; font-weight: 600; padding: 12px 28px; border-radius: 9999px; box-shadow: 0 2px 6px rgba(200, 90, 50, 0.25);">
                  Review Request in Dashboard &rarr;
                </a>
              </div>

              <!-- Privacy Notice -->
              <p style="font-size: 11px; line-height: 16px; color: #8F867A; margin: 20px 0 0 0; text-align: center;">
                Confidential employee details and private notes are safeguarded in accordance with organization privacy rules and can only be accessed through the secure portal by authorized personnel.
              </p>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="background-color: #F8F5EE; padding: 18px 32px; border-top: 1px solid #EDE7DC; text-align: center;">
              <p style="font-size: 11px; color: #8F867A; margin: 0;">
                Organizational Hierarchy &amp; Leave Management &bull; PugArch Cloud
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
`.trim();

  const result = await deliverMail({ to, subject, text, html });
  if (result.delivered) {
    return { delivered: true };
  }
  if (result.unconfigured && process.env.NODE_ENV !== 'production') {
    console.log(`\n======================================================`);
    console.log(`[EmailService DEV] Simulated leave request email to: ${to} (${recipientName})`);
    console.log(`[EmailService DEV] Requester: ${requesterName} (${requesterRole})`);
    console.log(`[EmailService DEV] Dates: ${startDate} to ${endDate} | Type: ${leaveType} (${dayType})`);
    console.log(`======================================================\n`);
    return { delivered: true, mockLogged: true };
  }
  return { delivered: false };
}

/**
 * Resolves recipients dynamically through organizational hierarchy and sends leave submission emails.
 * Prevents duplicates, removes requester, and ensures non-blocking failure tolerance.
 */
export async function dispatchLeaveSubmissionEmails(params: {
  leaveId: string;
  requesterId: string;
  requesterName: string;
  requesterRole: string;
  leaveType: string;
  dayType: string;
  startDate: Date | string;
  endDate: Date | string;
  submissionDate: Date | string;
  status: string;
}): Promise<{
  attempted: number;
  delivered: number;
  recipients: Array<{ name: string; email: string; role: string }>;
  errors: string[];
}> {
  const {
    requesterId,
    requesterName,
    requesterRole,
    leaveType,
    dayType,
    startDate,
    endDate,
    submissionDate,
    status,
  } = params;

  // Import dynamically to avoid circular dependencies if needed
  const { resolveLeaveNotificationRecipients } = await import('./authorizationService.js');
  const recipients = await resolveLeaveNotificationRecipients(requesterId);

  const timeZone = getAppTimeZone();
  const fmtDate = (d: Date | string) => {
    const date = typeof d === 'string' ? new Date(d) : d;
    return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone });
  };

  const fmtSubmission = (d: Date | string) => {
    const date = typeof d === 'string' ? new Date(d) : d;
    return date.toLocaleDateString('en-GB', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      timeZone,
    });
  };

  const appBaseUrl = resolvePortalUrl();
  const viewLink = `${appBaseUrl}/dashboard`;

  const startDateStr = fmtDate(startDate);
  const endDateStr = fmtDate(endDate);
  const submissionDateStr = fmtSubmission(submissionDate);

  let delivered = 0;
  const errors: string[] = [];

  for (const recipient of recipients) {
    try {
      await sendLeaveRequestEmail({
        to: recipient.email,
        recipientName: recipient.name,
        recipientRole: recipient.role,
        requesterName,
        requesterRole,
        leaveType,
        dayType,
        startDate: startDateStr,
        endDate: endDateStr,
        submissionDate: submissionDateStr,
        status,
        viewLink,
      });
      delivered++;
    } catch (err: any) {
      console.error(`[EmailService] Delivery error for recipient ${recipient.email}:`, err.message || err);
      errors.push(`${recipient.email}: ${err.message || 'Delivery error'}`);
    }
  }

  return {
    attempted: recipients.length,
    delivered,
    recipients,
    errors,
  };
}

export interface SendTaskAssignmentEmailParams {
  to: string;
  assigneeName: string;
  assignerName: string;
  projectName: string;
  taskTitle: string;
  priority: string;
  plannedStart: Date;
  plannedEnd: Date;
  plannedHours: number;
  frequency?: string;
  dailyHours?: number | null;
}

/**
 * Dispatches a task assignment email notification.
 * Failures are logged and never thrown so task creation is never blocked.
 */
export async function sendTaskAssignmentEmail(
  params: SendTaskAssignmentEmailParams
): Promise<{ delivered: boolean; mockLogged?: boolean }> {
  try {
    const {
      to,
      assigneeName,
      assignerName,
      projectName,
      taskTitle,
      priority,
      plannedStart,
      plannedEnd,
      plannedHours,
      frequency = 'ONE_TIME',
      dailyHours,
    } = params;

    const from = getFromAddress();
    const transporter = getTransporter();
    const portalUrl = resolvePortalUrl();

    const timeZone = getAppTimeZone();
    const fmtDate = (d: Date) =>
      new Date(d).toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        timeZone,
      });

    const startStr = fmtDate(plannedStart);
    const endStr = fmtDate(plannedEnd);
    const scheduleLabel =
      frequency === 'DAILY' && dailyHours
        ? `Daily (${dailyHours} hrs/day, ${plannedHours} hrs total)`
        : frequency === 'WEEKLY'
          ? `Weekly (${plannedHours} hrs planned)`
          : `One-time (${plannedHours} hrs planned)`;

    const subject = `New Task Assigned: ${taskTitle} (${projectName})`;
    const text = `
Hello ${assigneeName || 'Team Member'},

${assignerName} has assigned you a new task in "${projectName}":

Task: ${taskTitle}
Priority: ${priority}
Schedule: ${startStr} to ${endStr}
Effort: ${scheduleLabel}

View your tasks on PugArch: ${portalUrl}/projects

—
PugArch Projects Cloud
`.trim();

    const html = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin:0;padding:0;background-color:#F7F4ED;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#231E1B;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color:#F7F4ED;padding:32px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:560px;background-color:#FFFFFF;border-radius:20px;border:1px solid #EAE3D5;overflow:hidden;">
          <tr>
            <td style="padding:24px 28px;border-bottom:1px solid #F0EAE0;background-color:#FBF9F4;">
              <div style="font-size:11px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:#C85A32;">Task Assignment</div>
              <h1 style="margin:6px 0 0;font-size:20px;line-height:1.3;color:#231E1B;">${taskTitle}</h1>
            </td>
          </tr>
          <tr>
            <td style="padding:24px 28px;font-size:14px;line-height:1.6;color:#4B443D;">
              <p style="margin:0 0 16px;">Hello <strong>${assigneeName || 'Team Member'}</strong>,</p>
              <p style="margin:0 0 16px;"><strong>${assignerName}</strong> assigned you a task in <strong>${projectName}</strong>.</p>
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color:#FAF8F4;border:1px solid #EBE4D5;border-radius:12px;padding:14px 16px;margin-bottom:20px;font-size:13px;">
                <tr><td style="padding:4px 0;color:#70675D;width:110px;">Priority</td><td style="padding:4px 0;font-weight:600;color:#231E1B;">${priority}</td></tr>
                <tr><td style="padding:4px 0;color:#70675D;">Dates</td><td style="padding:4px 0;font-weight:600;color:#231E1B;">${startStr} – ${endStr}</td></tr>
                <tr><td style="padding:4px 0;color:#70675D;">Effort</td><td style="padding:4px 0;font-weight:600;color:#231E1B;">${scheduleLabel}</td></tr>
              </table>
              <a href="${portalUrl}/projects" style="display:inline-block;padding:10px 20px;background-color:#C85A32;color:#FFFFFF;text-decoration:none;border-radius:999px;font-size:13px;font-weight:600;">Open PugArch Projects</a>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`.trim();

    const result = await deliverMail({ to, subject, text, html });
    return { delivered: result.delivered, mockLogged: result.unconfigured };
  } catch (err: any) {
    console.error('[EmailService] Failed to send task assignment email:', err?.message || err);
    return { delivered: false };
  }
}

export interface SendReminderEmailParams {
  to: string;
  userName: string;
  title: string;
  description?: string | null;
  remindAt: Date;
}

/**
 * Dispatches a scheduled personal reminder email.
 * Never throws; returns true on delivery and false otherwise.
 */
export async function sendReminderEmail(params: SendReminderEmailParams): Promise<boolean> {
  try {
    const { to, userName, title, description, remindAt } = params;
    const portalUrl = resolvePortalUrl();

    const formattedTime = new Date(remindAt).toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      timeZone: getAppTimeZone(),
      timeZoneName: 'short',
    });

    const subject = `Reminder: ${title}`;
    const text = [
      `Hello ${userName || 'Team Member'},`,
      '',
      `This is your scheduled reminder: ${title}`,
      description ? `Details: ${description}` : '',
      `Scheduled for: ${formattedTime}`,
      '',
      `Open PugArch Calendar: ${portalUrl}/calendar`,
    ]
      .filter(Boolean)
      .join('\n');

    const html = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin:0;padding:0;background-color:#F7F4ED;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#231E1B;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color:#F7F4ED;padding:32px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:560px;background-color:#FFFFFF;border-radius:20px;border:1px solid #EAE3D5;overflow:hidden;">
          <tr>
            <td style="padding:24px 28px;border-bottom:1px solid #F0EAE0;background-color:#FBF9F4;">
              <div style="font-size:11px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:#C85A32;">Personal Reminder</div>
              <h1 style="margin:6px 0 0;font-size:20px;line-height:1.3;color:#231E1B;">${title}</h1>
            </td>
          </tr>
          <tr>
            <td style="padding:24px 28px;font-size:14px;line-height:1.6;color:#4B443D;">
              <p style="margin:0 0 14px;">Hello <strong>${userName || 'Team Member'}</strong>,</p>
              ${description ? `<p style="margin:0 0 16px;padding:12px 14px;background-color:#FAF8F4;border:1px solid #EBE4D5;border-radius:12px;font-size:13px;">${description}</p>` : ''}
              <p style="margin:0 0 20px;font-size:13px;color:#70675D;">Scheduled time: <strong style="color:#231E1B;">${formattedTime}</strong></p>
              <a href="${portalUrl}/calendar" style="display:inline-block;padding:10px 20px;background-color:#C85A32;color:#FFFFFF;text-decoration:none;border-radius:999px;font-size:13px;font-weight:600;">Open Calendar</a>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`.trim();

    const result = await deliverMail({ to, subject, text, html });
    return result.delivered;
  } catch (err: any) {
    console.error('[EmailService] Failed to send reminder email:', err?.message || err);
    return false;
  }
}
