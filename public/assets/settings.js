import { api, currentUser, goToLogin, renderSession, setBusy, showError, showMessage } from './common.js';

let user = null;

document.querySelector('#recovery-settings-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const submit = event.submitter;
  setBusy(submit, true, '正在保存……');
  try {
    await api('/auth/recovery/question', {
      method: 'PUT',
      body: {
        question: document.querySelector('#settings-question').value.trim(),
        answer: document.querySelector('#settings-answer').value.trim()
      }
    });
    document.querySelector('#settings-answer').value = '';
    showMessage('自定义找回问题和答案已保存。');
  } catch (error) {
    showError(error);
  } finally {
    setBusy(submit, false);
  }
});

async function initialize() {
  try {
    user = await currentUser();
    if (!user) { goToLogin('login'); return; }
    renderSession(user);
    document.querySelector('#account-name').textContent = user.username;
    document.querySelector('#account-email').textContent = user.email;
    const data = await api('/auth/recovery/question/mine');
    document.querySelector('#settings-question').value = data.question || '';
  } catch (error) {
    showError(error);
  }
}

initialize();
