// One floating hint, delegated events survive invoice re-renders.
const hint=document.createElement('div');hint.className='invoice-pointer-hint';hint.id='invoice-pointer-hint';hint.setAttribute('role','tooltip');hint.hidden=true;
hint.innerHTML='<span class="invoice-hint-icon" aria-hidden="true">↗</span><span><small>LIVE DOCUMENT</small><strong>Expand & edit</strong></span>';
document.body.append(hint);
const hide=()=>{hint.hidden=true;};
document.addEventListener('pointermove',event=>{
  const viewport=event.target.closest?.('#scaler-viewport');
  if(!viewport||event.pointerType==='touch'||document.querySelector('dialog[open]')||!matchMedia('(hover: hover)').matches)return hide();
  hint.hidden=false;const pad=12,w=hint.offsetWidth,h=hint.offsetHeight;
  hint.style.left=Math.max(pad,Math.min(event.clientX+18,innerWidth-w-pad))+'px';
  hint.style.top=Math.max(pad,event.clientY+h+22>innerHeight?event.clientY-h-14:event.clientY+22)+'px';
});
document.addEventListener('pointerout',e=>{if(!e.relatedTarget?.closest?.('#scaler-viewport'))hide();});
document.addEventListener('scroll',hide,true);document.addEventListener('pointerdown',hide,true);document.addEventListener('keydown',e=>{if(e.key==='Escape')hide();});window.addEventListener('blur',hide);
