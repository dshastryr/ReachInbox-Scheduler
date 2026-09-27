import "dotenv/config";
import nodemailer from "nodemailer";

export interface SmtpSettings {
  host: string;
  port: number;
  user: string;
  password: string;
  secure?: boolean;
}

export interface SendEmailOptions {
  from: string;
  to: string;
  subject: string;
  text: string;
  html?: string;
  smtp?: SmtpSettings;
}

function getSmtpSettings(settings?: SmtpSettings): Required<SmtpSettings> {
  const host = settings?.host ?? process.env.SMTP_HOST;
  const portValue = settings?.port ?? Number(process.env.SMTP_PORT || 587);
  const user = settings?.user ?? process.env.SMTP_USER;
  const password = settings?.password ?? process.env.SMTP_PASSWORD;
  const secureValue = process.env.SMTP_SECURE?.trim().toLowerCase();

  if (!host?.trim()) {
    throw new Error("SMTP_HOST is required");
  }
  if (!Number.isInteger(portValue) || portValue < 1 || portValue > 65535) {
    throw new Error("SMTP_PORT must be an integer between 1 and 65535");
  }
  if (!user?.trim()) {
    throw new Error("SMTP_USER is required");
  }
  if (!password) {
    throw new Error("SMTP_PASSWORD is required");
  }

  if (settings?.secure !== undefined) {
    return { host, port: portValue, user, password, secure: settings.secure };
  }

  if (secureValue && secureValue !== "true" && secureValue !== "false") {
    throw new Error("SMTP_SECURE must be either true or false");
  }

  return {
    host,
    port: portValue,
    user,
    password,
    secure: secureValue ? secureValue === "true" : portValue === 465,
  };
}

export async function sendEmail({
  from,
  to,
  subject,
  text,
  html,
  smtp,
}: SendEmailOptions) {
  const settings = getSmtpSettings(smtp);
  const transporter = nodemailer.createTransport({
    host: settings.host,
    port: settings.port,
    secure: settings.secure,
    auth: {
      user: settings.user,
      pass: settings.password,
    },
  });

  const info = await transporter.sendMail({ from, to, subject, text, html });
  const previewUrl = nodemailer.getTestMessageUrl(info);

  return {
    previewUrl: typeof previewUrl === "string" ? previewUrl : undefined,
  };
}
