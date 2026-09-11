const button=document.querySelector('#install-button');
const dialog=document.querySelector('#install-dialog');
let installPrompt;
const standalone=()=>matchMedia('(display-mode: standalone)').matches||navigator.standalone===true;
function refresh(){button.hidden=standalone();}
window.addEventListener('beforeinstallprompt',event=>{event.preventDefault();installPrompt=event;refresh();});
window.addEventListener('appinstalled',()=>{installPrompt=null;button.hidden=true;dialog.close();});
document.querySelector('#close-install').addEventListener('click',()=>dialog.close());
button.addEventListener('click',async()=>{
  if(installPrompt){const prompt=installPrompt;installPrompt=null;try{await prompt.prompt();await prompt.userChoice;}catch{}return;}
  const local=['localhost','127.0.0.1','[::1]'].includes(location.hostname);
  document.querySelector('#install-context').textContent=local?'This is a computer-only preview address. Use the hosted HTTPS address on your phone.':`Open ${location.origin}${location.pathname} on your phone to install.`;
  const status=document.querySelector('#offline-ready');status.textContent='Checking offline readiness…';dialog.showModal();
  try{const registration=await navigator.serviceWorker?.getRegistration();status.textContent=registration?.active?'Offline shell installed on this browser.':'Offline shell is still preparing. Stay connected and reopen these instructions in a moment.';}catch{status.textContent='Offline status unavailable. Reload while connected and try again.';}
});
refresh();
