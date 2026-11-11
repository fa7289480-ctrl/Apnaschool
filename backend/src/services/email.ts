/**
 * Email service.
 *
 * When SMTP_HOST is configured, sends real mail via nodemailer. Otherwise it
 * runs in "dev/log" mode: nothing leaves the process — the message is logged
 * and captured in `sentEmails`, so developers and tests can still read the
 * verification / reset links. This keeps the auth flows exercisable without an
 * external email provider.
 */

import nodemailer, { type Transporter } from 'nodemailer';
import { env, isProduction, isTest } from '../config/env.js';
import { logger } from '../middleware/requestLogger.js';

export interface SentEmail {
  to: string;
  subject: string;
  text: string;
  html?: string;
  createdAt: Date;
}

/** Captured messages in dev/log mode (cleared per-process). */
export const sentEmails: SentEmail[] = [];

export function clearSentEmails(): void {
  sentEmails.length = 0;
}

export const emailEnabled = Boolean(env.SMTP_HOST);

let transporter: Transporter | null = null;

function getTransporter(): Transporter {
  if (transporter) return transporter;
  transporter = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_SECURE,
    auth:
      env.SMTP_USER || env.SMTP_PASSWORD
        ? { user: env.SMTP_USER ?? '', pass: env.SMTP_PASSWORD ?? '' }
        : undefined,
  });
  return transporter;
}

interface SendInput {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export async function sendEmail(input: SendInput): Promise<void> {
  const from = env.SMTP_FROM ?? 'ApnaSchool <no-reply@apnaschool.pk>';

  if (emailEnabled) {
    await getTransporter().sendMail({ from, ...input });
    return;
  }

  // Dev/log mode — never send, just record.
  sentEmails.push({ ...input, createdAt: new Date() });
  // Avoid dumping full emails (which contain tokens) in production logs.
  if (!isProduction && !isTest) {
    logger.info(
      { to: input.to, subject: input.subject },
      '[dev email] message captured (no SMTP configured)',
    );
  }
}

export async function sendVerificationEmail(
  to: string,
  params: { name: string; verificationUrl: string },
): Promise<void> {
  const subject = 'Verify your ApnaSchool account';
  const text = `Hi ${params.name},\n\nVerify your ApnaSchool account by opening this link:\n${params.verificationUrl}\n\nIf you did not sign up, you can ignore this email.`;
  const html = `<p>Hi ${params.name},</p><p>Verify your ApnaSchool account by clicking the link below:</p><p><a href="${params.verificationUrl}">Verify my account</a></p><p style="font-size:12px;color:#666">${params.verificationUrl}</p><p>If you did not sign up, you can ignore this email.</p>`;
  await sendEmail({ to, subject, text, html });
}

export async function sendPasswordResetEmail(
  to: string,
  params: { name: string; resetUrl: string },
): Promise<void> {
  const subject = 'Reset your ApnaSchool password';
  const text = `Hi ${params.name},\n\nReset your ApnaSchool password by opening this link (it expires in ${env.TOKEN_TTL_MINUTES} minutes):\n${params.resetUrl}\n\nIf you did not request a reset, your account is safe — no action is needed.`;
  const html = `<p>Hi ${params.name},</p><p>Reset your password by clicking the link below (expires in ${env.TOKEN_TTL_MINUTES} minutes):</p><p><a href="${params.resetUrl}">Reset my password</a></p><p style="font-size:12px;color:#666">${params.resetUrl}</p><p>If you did not request a reset, you can ignore this email.</p>`;
  await sendEmail({ to, subject, text, html });
}
