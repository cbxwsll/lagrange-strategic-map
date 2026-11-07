import nodemailer from 'nodemailer';
import { fail } from './errors.js';

const subjects = {
  register: '拉格朗日战略地图注册验证码',
  login: '拉格朗日战略地图登录验证码',
  recovery: '拉格朗日战略地图找回验证码'
};

export function createMailer(config) {
  let transport = null;
  if (config.smtp.host) {
    transport = nodemailer.createTransport({
      host: config.smtp.host,
      port: config.smtp.port,
      secure: config.smtp.secure,
      auth: { user: config.smtp.user, pass: config.smtp.pass },
      connectionTimeout: 10_000,
      socketTimeout: 15_000
    });
  }
  return {
    async sendCode(email, purpose, code) {
      if (!transport) fail(503, 'SMTP_NOT_CONFIGURED', '邮件发信通道尚未配置');
      await transport.sendMail({
        from: config.smtp.from,
        to: email,
        subject: subjects[purpose],
        text: `验证码：${code}\n${config.emailCodeTtlMinutes} 分钟内有效。请勿转发给他人。`
      });
    }
  };
}
