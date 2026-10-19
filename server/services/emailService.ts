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
 */
function getTransporter(): Transporter | null {
  const host = process.env.SMTP_HOST?.trim();
  if (!host) {
    return null;
  }

  const port = parseInt(process.env.SMTP_PORT?.trim() || '587', 10);
  const secure =
    process.env.SMTP_SECURE === 'true' ||
    process.env.SMTP_SECURE === '1' ||
    port === 465;
  const user = process.env.SMTP_USER?.trim();
  const pass = process.env.SMTP_PASS?.trim();

  return nodemailer.createTransport({
    host,
    port,
    secure,
    auth: user ? { user, pass } : undefined,
  });
}

function getFromAddress(): string {
  return (
    process.env.EMAIL_FROM?.trim() ||
    'PugArch Security <no-reply@pugarch.internal>'
  );
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

  if (transporter) {
    try {
      await transporter.sendMail({
        from,
        to,
        subject,
        text,
        html,
      });
      return { delivered: true };
    } catch (err: any) {
      console.error(`[EmailService] Failed to deliver verification email to ${to}:`, err.message || err);
      throw new Error(`Email delivery failed: ${err.message || 'SMTP transport error'}`);
    }
  }

  // Fallback for development / test environments when SMTP_HOST is not configured
  const isDev = process.env.NODE_ENV !== 'production';
  if (isDev) {
    console.log(`\n======================================================`);
    console.log(`[EmailService DEV] Simulated verification email to: ${to}`);
    console.log(`[EmailService DEV] OTP Code: ${otp} (Expires in 5 minutes)`);
    console.log(`======================================================\n`);
    return { delivered: true, mockLogged: true };
  }

  throw new Error('Email service configuration error: SMTP_HOST environment variable is required in production.');
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

  if (transporter) {
    try {
      await transporter.sendMail({
        from,
        to,
        subject,
        text,
        html,
      });
      return { delivered: true };
    } catch (err: any) {
      console.error(`[EmailService] Failed to deliver recovery email to ${to}:`, err.message || err);
      throw new Error(`Email delivery failed: ${err.message || 'SMTP transport error'}`);
    }
  }

  const isDev = process.env.NODE_ENV !== 'production';
  if (isDev) {
    console.log(`\n======================================================`);
    console.log(`[EmailService DEV] Simulated password recovery email to: ${to}`);
    console.log(`[EmailService DEV] Recovery Code: ${otp} (Expires in 5 minutes)`);
    console.log(`======================================================\n`);
    return { delivered: true, mockLogged: true };
  }

  throw new Error('Email service configuration error: SMTP_HOST environment variable is required in production.');
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

  if (transporter) {
    try {
      await transporter.sendMail({
        from,
        to,
        subject,
        text,
        html,
      });
      return { delivered: true };
    } catch (err: any) {
      console.error(`[EmailService] Failed to deliver leave request email to ${to}:`, err.message || err);
      throw new Error(`Email delivery failed: ${err.message || 'SMTP transport error'}`);
    }
  }

  const isDev = process.env.NODE_ENV !== 'production';
  if (isDev) {
    console.log(`\n======================================================`);
    console.log(`[EmailService DEV] Simulated leave request email to: ${to} (${recipientName})`);
    console.log(`[EmailService DEV] Requester: ${requesterName} (${requesterRole})`);
    console.log(`[EmailService DEV] Dates: ${startDate} to ${endDate} | Type: ${leaveType} (${dayType})`);
    console.log(`======================================================\n`);
    return { delivered: true, mockLogged: true };
  }

  throw new Error('Email service configuration error: SMTP_HOST environment variable is required in production.');
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

  const fmtDate = (d: Date | string) => {
    const date = typeof d === 'string' ? new Date(d) : d;
    return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  };

  const fmtSubmission = (d: Date | string) => {
    const date = typeof d === 'string' ? new Date(d) : d;
    return date.toLocaleDateString('en-GB', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  const appBaseUrl = (process.env.APP_URL || 'http://localhost:3000').trim().replace(/\/+$/, '');
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
