let deferredPrompt;

function refresh() {
  const btn = document.getElementById('install-btn');
  if (btn) {
    btn.hidden = !deferredPrompt;
  }
}

window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  deferredPrompt = e;
  refresh();
});

window.addEventListener('appinstalled', () => {
  deferredPrompt = null;
  refresh();
});