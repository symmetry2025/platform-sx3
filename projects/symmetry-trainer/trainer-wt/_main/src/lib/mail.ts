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

function cleanEnvValue(raw: unknown): string {
  let v = String(raw ?? '').trim();
  // Avoid broken values when env got serialized with newlines.
  v = v.replaceAll('\r', ' ').replaceAll('\n', ' ').trim();
  // Strip wrapping quotes if present (common when .env / secrets include quotes).
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    v = v.slice(1, -1).trim();
  }
  return v;
}

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
  const host = cleanEnvValue(env.SMTP_HOST);
  const portRaw = cleanEnvValue(env.SMTP_PORT);
  const port = portRaw ? Number(portRaw) : NaN;
  const secure = parseBool(env.SMTP_SECURE, port === 465);
  const user = cleanEnvValue(env.SMTP_USER);
  const pass = cleanEnvValue(env.SMTP_PASS);
  const from = cleanEnvValue(env.MAIL_FROM);
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

function serializeMailError(err: unknown): Record<string, unknown> {
  if (!err || typeof err !== 'object') return { message: String(err) };
  const e = err as any;
  return {
    name: typeof e.name === 'string' ? e.name : undefined,
    message: typeof e.message === 'string' ? e.message : String(err),
    code: typeof e.code === 'string' ? e.code : undefined,
    command: typeof e.command === 'string' ? e.command : undefined,
    responseCode: typeof e.responseCode === 'number' ? e.responseCode : undefined,
    response: typeof e.response === 'string' ? e.response : undefined,
    errno: typeof e.errno === 'number' ? e.errno : undefined,
    syscall: typeof e.syscall === 'string' ? e.syscall : undefined,
    address: typeof e.address === 'string' ? e.address : undefined,
    port: typeof e.port === 'number' ? e.port : undefined,
  };
}

export async function sendMail(params: { to: string } & RenderedEmail): Promise<{ messageId?: string }> {
  const to = params.to.trim();
  if (!to) throw new Error('Missing "to"');

  const cfg = readSmtpConfigFromEnv(process.env);
  const connectionTimeoutMs = 10_000;
  const greetingTimeoutMs = 10_000;
  const socketTimeoutMs = 20_000;

  // eslint-disable-next-line no-console
  console.log(
    `[mail] sending host=${cfg.host} port=${cfg.port} secure=${cfg.secure} family=${cfg.ipFamily} user=${cfg.user} from="${cfg.from}" to="${to}"`,
  );

  const transporter = nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    auth: { user: cfg.user, pass: cfg.pass },
    connectionTimeout: connectionTimeoutMs,
    greetingTimeout: greetingTimeoutMs,
    socketTimeout: socketTimeoutMs,
    family: cfg.ipFamily === 0 ? undefined : cfg.ipFamily,
  } as SMTPTransport.Options);

  const startedAt = Date.now();
  try {
    const info = await withTimeout(
      transporter.sendMail({
        from: cfg.from,
        to,
        subject: params.subject,
        text: params.text,
        html: params.html,
      }),
      30_000,
      'SMTP send timed out',
    );
    const durationMs = Date.now() - startedAt;
    // eslint-disable-next-line no-console
    console.log(`[mail] sent (duration=${durationMs}ms) messageId=${info.messageId ?? '-'}`);
    return { messageId: info.messageId };
  } catch (err) {
    const durationMs = Date.now() - startedAt;
    // eslint-disable-next-line no-console
    console.error(`[mail] send failed (duration=${durationMs}ms)`, serializeMailError(err));
    throw err;
  } finally {
    // Best-effort: close underlying sockets (important if we later enable pooling).
    try {
      transporter.close();
    } catch {
      // ignore
    }
  }
}

