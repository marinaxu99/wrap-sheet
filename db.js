// Each operation resolves only after its transaction commits.
let database;
export async function openDB() {
  if (database) return database;
  database = await new Promise((resolve,reject) => {
    const request = indexedDB.open('wrapsheet',2);
    request.onupgradeneeded = () => {
      // v2 adds client formats and the imported shoot calendar; existing stores are kept.
      for (const name of ['projects','receipts','templates','snapshots','formats','schedule'])
        if (!request.result.objectStoreNames.contains(name)) request.result.createObjectStore(name,{keyPath:'id'});
    };
    request.onsuccess=()=>{request.result.onversionchange=()=>{request.result.close();database=null;};resolve(request.result);};
    request.onerror=()=>reject(request.error);
    request.onblocked=()=>reject(new Error('Close other WrapSheet tabs and reload to update storage.'));
  });
  return database;
}
export async function transact(store, mode, action) {
  const db=await openDB();
  return new Promise((resolve,reject)=>{
    const tx=db.transaction(store,mode);let result;
    const req=action(tx.objectStore(store));req.onsuccess=()=>result=req.result;
    tx.oncomplete=()=>resolve(result);tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error||new Error('Storage was interrupted.'));
  });
}
export const get=(store,id)=>transact(store,'readonly',s=>s.get(id));
export const all=store=>transact(store,'readonly',s=>s.getAll());
export const put=(store,value)=>transact(store,'readwrite',s=>s.put(value));
export const remove=(store,id)=>transact(store,'readwrite',s=>s.delete(id));
export const putMany=(store,values)=>transact(store,'readwrite',s=>{let last;for(const v of values)last=s.put(v);return last||s.count();});
export const clear=store=>transact(store,'readwrite',s=>s.clear());
