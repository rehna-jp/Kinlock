import nodemailer from "nodemailer";
import { Resend } from "resend";

// Owner-supplied text goes into emails: strip newlines and cap length.
export const clean = (s: string, max = 80) => String(s).replace(/[\r\n]+/g, " ").slice(0, max);

// Sends through Gmail when GMAIL_USER and GMAIL_APP_PASSWORD are set; otherwise through Resend.
export async function sendMail(to: string, subject: string, text: string) {
  const subj = clean(subject, 120);
  const user = process.env.GMAIL_USER;
  const pass = process.env.GMAIL_APP_PASSWORD;
  if (user && pass) {
    const transport = nodemailer.createTransport({
      host: "smtp.gmail.com", port: 465, secure: true,
      auth: { user, pass: pass.replace(/\s/g, "") },
    });
    await transport.sendMail({ from: `KinLock <${user}>`, to, subject: subj, text });
    return;
  }
  const { error } = await new Resend(process.env.RESEND_API_KEY!).emails.send({ from: process.env.MAIL_FROM!, to, subject: subj, text });
  if (error) throw new Error(error.message);
}
