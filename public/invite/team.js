const codePattern = /^[A-Z0-9]{8}$/;
const query = new URLSearchParams(window.location.search);
const code = query.get('code')?.toUpperCase() ?? '';
const codeElement = document.querySelector('#join-code');
const copyButton = document.querySelector('#copy-code');
const status = document.querySelector('#invite-status');

if (codeElement instanceof HTMLElement && copyButton instanceof HTMLButtonElement) {
  if (codePattern.test(code)) {
    codeElement.textContent = code;
    copyButton.disabled = false;
    copyButton.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(code);
        if (status instanceof HTMLElement) status.textContent = 'Join Code copied.';
      } catch {
        if (status instanceof HTMLElement) {
          status.textContent = 'Copy is unavailable. Select and copy the Join Code above.';
        }
      }
    });
  } else {
    codeElement.textContent = 'Invite link is incomplete';
    if (status instanceof HTMLElement) {
      status.textContent = 'Open the complete invite link shared by the Team Leader.';
    }
  }
}
