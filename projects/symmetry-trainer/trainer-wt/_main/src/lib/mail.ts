import nodemailer from 'nodemailer';
import type SMTPTransport from 'nodemailer/lib/smtp-transport';

import type { RenderedEmail } from './mailTemplates';

type SmtpConfig = {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  from: string;
  ipFamily: 0 | 4 | 6;
};

function parseBool(raw: string | undefined, fallback: boolean): boolean {
  const v = (raw ?? '').trim().toLowerCase();
  if (!v) return fallback;
  if (['1', 'true', 'yes', 'y', 'on'].includes(v)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(v)) return false;
  return fallback;
}

function parseIpFamily(raw: unknown): 0 | 4 | 6 {
  const v = String(raw ?? '').trim();
  if (!v) return 4; // Default to IPv4 to avoid IPv6-first timeouts on many VPS.
  if (v === '0') return 0;
  if (v === '4') return 4;
  if (v === '6') return 6;
  return 4;
}

function readSmtpConfigFromEnv(env: NodeJS.ProcessEnv): SmtpConfig {
  const host = String(env.SMTP_HOST ?? '').trim();
  const portRaw = String(env.SMTP_PORT ?? '').trim();
  const port = portRaw ? Number(portRaw) : NaN;
  const secure = parseBool(env.SMTP_SECURE, port === 465);
  const user = String(env.SMTP_USER ?? '').trim();
  const pass = String(env.SMTP_PASS ?? '').trim();
  const from = String(env.MAIL_FROM ?? '').trim();
  const ipFamily = parseIpFamily(env.SMTP_IP_FAMILY);

  if (!host) throw new Error('SMTP_HOST is required');
  if (!portRaw || !Number.isFinite(port)) throw new Error('SMTP_PORT must be a number');
  if (!user) throw new Error('SMTP_USER is required');
  if (!pass) throw new Error('SMTP_PASS is required');
  if (!from) throw new Error('MAIL_FROM is required');

  return { host, port, secure, user, pass, from, ipFamily };
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(message)), timeoutMs);
    promise.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

export async function sendMail(params: { to: string } & RenderedEmail): Promise<{ messageId?: string }> {
  const to = params.to.trim();
  if (!to) throw new Error('Missing "to"');

  const cfg = readSmtpConfigFromEnv(process.env);
  const transportTimeoutMs = 10_000;
  const transporter = nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    auth: { user: cfg.user, pass: cfg.pass },
    connectionTimeout: transportTimeoutMs,
    greetingTimeout: transportTimeoutMs,
    socketTimeout: transportTimeoutMs,
    family: cfg.ipFamily === 0 ? undefined : cfg.ipFamily,
  } as SMTPTransport.Options);

  const startedAt = Date.now();
  const info = await withTimeout(
    transporter.sendMail({
      from: cfg.from,
      to,
      subject: params.subject,
      text: params.text,
      html: params.html,
    }),
    15_000,
    'SMTP send timed out',
  );
  const durationMs = Date.now() - startedAt;
  // eslint-disable-next-line no-console
  console.log(`[mail] sent (duration=${durationMs}ms)`);
  return { messageId: info.messageId };
}

