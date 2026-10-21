import { PDF_FIELDS, esc, fieldValues, validateMapping, recognizePDF } from './pdf-template.js';
export function editPDFTemplate(original,state,getKey){
  const draft=structuredClone(original);let pageIndex=0,selected=draft.pdf.fields[0]?.id,busy=false,drag=null;
  const values=fieldValues(state),dialog=document.createElement('dialog');dialog.className='pdf-map-dialog';
  dialog.innerHTML=`<header class="pdf-map-header"><div><span class="eyebrow">PERSONAL INVOICE / ONE-TIME SETUP</span><h2>Make this format yours.</h2></div><button type="button" data-map="cancel" aria-label="Cancel PDF setup">×</button></header>
  <p class="hint">Your PDF stays on this device. Its printed design and text remain visible. Check each suggested field; drag it into place or use the position controls. A blank template works best.</p>
  <div class="pdf-map-toolbar"><label>Template name<input id="pdf-name" maxlength="100" value="${esc(draft.name)}"></label><label>Page<select id="pdf-page">${draft.pdf.pages.map((_,i)=>`<option value="${i}">Page ${i+1}</option>`).join('')}</select></label><label>Add a field<select id="pdf-key">${Object.entries(PDF_FIELDS).map(([k,v])=>`<option value="${k}">${v}</option>`).join('')}</select></label><button data-map="add">＋ Place field</button></div>
  <details><summary>Optional automatic layout analysis</summary><p class="hint">Analyze sends images of every template page to Google Gemini using your saved API key. Local setup works without it. Analysis replaces current suggestions; saved templates are unchanged until you save.</p><button data-map="analyze">Send pages to Gemini & detect fields</button></details>
  <p id="pdf-map-status" role="status" class="hint"></p><div class="pdf-map-layout"><div class="pdf-map-scroll"><div id="pdf-map-canvas"></div></div><aside id="pdf-map-properties"></aside></div>
  <footer class="pdf-map-actions"><button data-map="cancel">Cancel</button><button class="primary" data-map="save">Save & use template</button></footer>`;
  document.body.append(dialog);
  const $=s=>dialog.querySelector(s),status=t=>$('#pdf-map-status').textContent=t;
  const field=()=>draft.pdf.fields.find(f=>f.id===selected);
  function draw(){
    const page=draft.pdf.pages[pageIndex],canvas=$('#pdf-map-canvas');canvas.style.height=page.height+'px';
    canvas.innerHTML=`<img src="${page.image}" alt="Uploaded template page ${pageIndex+1}" draggable="false">${draft.pdf.fields.filter(f=>f.page===pageIndex).map(f=>`<button type="button" class="pdf-map-field ${selected===f.id?'selected':''} ${f.reviewed?'reviewed':''}" data-field-id="${f.id}" style="left:${f.x}px;top:${f.y}px;width:${f.width}px;height:${f.height}px;font-size:${f.fontSize}px;${f.cover?'background:#fff;':''}" aria-label="Move ${PDF_FIELDS[f.key]}"><span class="pdf-map-label">${esc(PDF_FIELDS[f.key])}${f.reviewed?' ✓':' · review'}</span><span class="pdf-map-value">${esc(values[f.key]||`[${PDF_FIELDS[f.key]}]`)}</span></button>`).join('')}`;
    properties();
  }
  function properties(){const f=field();$('#pdf-map-properties').innerHTML=`<label>Mapped fields<select id="pdf-selected"><option value="">Choose a field</option>${draft.pdf.fields.map(f=>`<option value="${f.id}" ${f.id===selected?'selected':''}>P${f.page+1} · ${esc(PDF_FIELDS[f.key])}${f.reviewed?' ✓':''}</option>`).join('')}</select></label>`+(f?`<p class="hint">${esc(f.source||'Manual placement')}</p><div class="pdf-coordinate-grid">${[['x','Left'],['y','Top'],['width','Width'],['height','Height'],['fontSize','Text size']].map(([key,label])=>`<label>${label}<input type="number" step="1" min="${key==='fontSize'?6:0}" data-coordinate="${key}" value="${Math.round(f[key]*10)/10}"></label>`).join('')}</div><label class="check-pill"><input id="pdf-cover" type="checkbox" ${f.cover?'checked':''}><span>Cover existing value with white</span></label><p class="hint">Covering hides everything inside this box, including lines. Keep labels outside it.</p><button data-map="review" class="primary">${f.reviewed?'✓ Position reviewed':'Confirm this field'}</button><button data-map="remove" class="remove">Remove field</button>`:'<p class="hint">Choose a detected field, or add one above. Work and expense fields need enough height for all rows.</p>');}
  function move(event){if(!drag)return;const f=field(),p=draft.pdf.pages[f.page];f.x=Math.max(0,Math.min(680-f.width,drag.x+event.clientX-drag.clientX));f.y=Math.max(0,Math.min(p.height-f.height,drag.y+event.clientY-drag.clientY));f.reviewed=false;const el=dialog.querySelector(`[data-field-id="${f.id}"]`);el.style.left=f.x+'px';el.style.top=f.y+'px';}
  function up(){if(drag){drag=null;draw();}}
  document.addEventListener('pointermove',move);document.addEventListener('pointerup',up);document.addEventListener('pointercancel',up);
  dialog.addEventListener('pointerdown',ev=>{const target=ev.target.closest('[data-field-id]');if(!target||busy)return;selected=target.dataset.fieldId;const f=field();drag={x:f.x,y:f.y,clientX:ev.clientX,clientY:ev.clientY};target.setPointerCapture(ev.pointerId);target.classList.add('selected');properties();});
  dialog.addEventListener('change',ev=>{if(busy)return;try{const el=ev.target;if(el.id==='pdf-page'){pageIndex=Number(el.value);draw();}else if(el.id==='pdf-selected'){selected=el.value;const f=field();if(f){pageIndex=f.page;$('#pdf-page').value=pageIndex;}draw();}else if(el.dataset.coordinate){const f=field(),old=f[el.dataset.coordinate];f[el.dataset.coordinate]=Number(el.value);try{validateMapping(draft);}catch(e){f[el.dataset.coordinate]=old;throw e;}f.reviewed=false;draw();}else if(el.id==='pdf-cover'){field().cover=el.checked;field().reviewed=false;draw();}}catch(e){status(e.message);properties();}});
  return new Promise(resolve=>{
    function finish(result){document.removeEventListener('pointermove',move);document.removeEventListener('pointerup',up);document.removeEventListener('pointercancel',up);dialog.close();dialog.remove();resolve(result);}
    dialog.addEventListener('cancel',ev=>{ev.preventDefault();if(!busy)finish(null);});
    dialog.addEventListener('click',async ev=>{const action=ev.target.closest('[data-map]')?.dataset.map;if(!action||busy)return;try{
      if(action==='cancel')return finish(null);
      if(action==='add'){const key=$('#pdf-key').value,p=draft.pdf.pages[pageIndex];const f={id:crypto.randomUUID(),page:pageIndex,key,x:40,y:60,width:Math.min(580, key.endsWith('Table')?580:250),height:Math.min(p.height-60,key.endsWith('Table')?150:40),fontSize:12,cover:false,reviewed:false,source:'Manual placement'};draft.pdf.fields.push(f);selected=f.id;draw();}
      if(action==='remove'){draft.pdf.fields=draft.pdf.fields.filter(f=>f.id!==selected);selected=null;draw();}
      if(action==='review'){field().reviewed=true;draw();}
      if(action==='analyze'){busy=true;status('Analyzing layout…');try{const fields=await recognizePDF(draft.pdf,getKey());if(!fields.length){status('No confident fields found. Existing suggestions retained; place fields manually.');return;}draft.pdf.fields=fields;selected=fields[0].id;pageIndex=fields[0].page;$('#pdf-page').value=pageIndex;draw();status('Suggestions ready. Review every field before saving.');}finally{busy=false;}}
      if(action==='save'){
        draft.name=$('#pdf-name').value.trim();if(!draft.name)throw Error('Give this template a name.');validateMapping(draft);
        if(!draft.pdf.fields.some(f=>f.key==='totalAmountDue'))throw Error('Place the Total due field before saving.');
        if(draft.pdf.fields.some(f=>!f.reviewed))throw Error('Confirm each suggested field position before saving.');
        for(const key of ['laborTable','expenseTable'])if(draft.pdf.fields.filter(f=>f.key===key).length>1)throw Error('Use one work-items box and one expense-items box. Split long invoices into separate projects.');
        draft.pdf.confirmed=true;finish(draft);
      }
    }catch(e){status(e.message);}});
    draw();status(draft.pdf.fields.length?`${draft.pdf.fields.length} suggested fields. Review positions; add work and expense areas as needed.`:'No fields confidently detected. Add fields manually or use optional Gemini analysis.');dialog.showModal();
  });
}
