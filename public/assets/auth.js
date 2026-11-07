import { api, currentSession, renderSession, runtime, setBusy, showError, showMessage } from './common.js';

const BETA_WELCOME_PENDING = 'lagrange.beta-welcome.pending';

function queueBetaWelcome(response) {
  try {
    window.sessionStorage.removeItem(BETA_WELCOME_PENDING);
    if (response.betaWelcome) window.sessionStorage.setItem(BETA_WELCOME_PENDING, response.user.username);
  } catch { /* 存储不可用时仍允许正常登录 */ }
}

const sections = {
  login: document.querySelector('#login-section'),
  register: document.querySelector('#register-section'),
  recovery: document.querySelector('#recovery-section')
};

function setMode(mode) {
  const selected = sections[mode] ? mode : 'login';
  for (const [name, section] of Object.entries(sections)) section.hidden = name !== selected;
  for (const button of document.querySelectorAll('[data-mode]')) {
    button.setAttribute('aria-pressed', String(button.dataset.mode === mode));
  }
  showMessage('');
}

for (const button of document.querySelectorAll('[data-mode]')) {
  button.addEventListener('click', () => setMode(button.dataset.mode));
}

function startResendCountdown(button) {
  let remaining = 60;
  const original = button.textContent;
  button.disabled = true;
  button.textContent = `${remaining} 秒后可重发`;
  const timer = window.setInterval(() => {
    remaining -= 1;
    if (remaining <= 0) {
      window.clearInterval(timer);
      button.disabled = false;
      button.textContent = original;
    } else {
      button.textContent = `${remaining} 秒后可重发`;
    }
  }, 1000);
}

for (const button of document.querySelectorAll('[data-send-code]')) {
  button.addEventListener('click', async () => {
    const purpose = button.dataset.sendCode;
    const emailInput = document.querySelector(`#${purpose}-email`);
    if (!emailInput.reportValidity()) return;
    setBusy(button, true, '正在发送……');
    try {
      await api('/auth/email-codes', { method: 'POST', body: { email: emailInput.value.trim(), purpose } });
      showMessage('验证码已发送，请检查邮箱。');
      button.textContent = button.dataset.originalText;
      startResendCountdown(button);
    } catch (error) {
      showError(error);
      setBusy(button, false);
    }
  });
}

document.querySelector('#login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const submit = event.submitter;
  const method = submit.dataset.loginMethod;
  const email = document.querySelector('#login-email').value.trim();
  const password = document.querySelector('#login-password').value;
  const code = document.querySelector('#login-code').value.trim();
  if (method === 'password' && !password) {
    showMessage('密码登录需要填写密码。', 'error');
    return;
  }
  if (method === 'email' && !/^\d{6}$/.test(code)) {
    showMessage('验证码登录需要填写 6 位数字验证码。', 'error');
    return;
  }
  setBusy(submit, true, '正在登录……');
  try {
    const path = method === 'email' ? '/auth/login/email' : '/auth/login';
    const response = await api(path, { method: 'POST', body: method === 'email' ? { email, code } : { email, password } });
    queueBetaWelcome(response);
    window.location.href = runtime.page('index.html');
  } catch (error) {
    showError(error);
    setBusy(submit, false);
  }
});

document.querySelector('#register-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const submit = event.submitter;
  const intent = submit.dataset.intent;
  setBusy(submit, true, '正在注册……');
  try {
    const response = await api('/auth/register', {
      method: 'POST',
      body: {
        email: document.querySelector('#register-email').value.trim(),
        code: document.querySelector('#register-code').value.trim(),
        username: document.querySelector('#register-username').value.trim(),
        password: document.querySelector('#register-password').value,
        inviteCode: document.querySelector('#register-invite-code').value.trim(),
        intent
      }
    });
    queueBetaWelcome(response);
    window.location.href = runtime.page(intent === 'create' ? 'create.html' : 'index.html');
  } catch (error) {
    showError(error);
    setBusy(submit, false);
  }
});

document.querySelector('#load-recovery-question').addEventListener('click', async (event) => {
  event.preventDefault();
  const email = document.querySelector('#recovery-email').value.trim();
  if (!document.querySelector('#recovery-email').reportValidity()) return;
  setBusy(event.currentTarget, true, '正在读取……');
  try {
    const data = await api(`/auth/recovery/question?email=${encodeURIComponent(email)}`);
    const target = document.querySelector('#recovery-question');
    target.textContent = `找回问题：${data.question}`;
    target.hidden = false;
    showMessage('已读取问题，请填写答案和新密码。');
  } catch (error) {
    showError(error);
  } finally {
    setBusy(event.currentTarget, false);
  }
});

document.querySelector('#recovery-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const submit = event.submitter;
  setBusy(submit, true, '正在重置……');
  try {
    await api('/auth/recovery/reset', {
      method: 'POST',
      body: {
        email: document.querySelector('#recovery-email').value.trim(),
        answer: document.querySelector('#recovery-answer').value,
        newPassword: document.querySelector('#recovery-new-password').value
      }
    });
    showMessage('密码已重置，请使用新密码登录。');
    setMode('login');
    showMessage('密码已重置，请使用新密码登录。');
  } catch (error) {
    showError(error);
  } finally {
    setBusy(submit, false);
  }
});

async function initialize() {
  try {
    const session = await currentSession();
    renderSession(session.user);
    document.querySelector('#invite-field').hidden = !session.inviteRequired;
    document.querySelector('#register-invite-code').required = session.inviteRequired;
  } catch { renderSession(null); }
  const parameters = new URL(window.location.href).searchParams;
  setMode(parameters.get('mode') || 'login');
}

initialize();
