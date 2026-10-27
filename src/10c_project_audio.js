/* Compressed source audio: browser recovery and portable project JSON. */
(() => {
'use strict';
let database = null;
function open() {
  if (database) return Promise.resolve(database);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('jizura-audio-v1', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('files');
    req.onerror = () => reject(req.error || new Error('曲の保存領域を開けません'));
    req.onblocked = () => reject(new Error('別のタブを閉じてから再試行してください'));
    req.onsuccess = () => {
      database = req.result;
      database.onversionchange = () => { database.close(); database = null; };
      resolve(database);
    };
  });
}
async function transaction(mode, action) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('files', mode);
    const req = action(tx.objectStore('files'));
    // Request success is not a committed write: quota failures can abort later.
    tx.oncomplete = () => resolve(req.result);
    tx.onabort = tx.onerror = () => reject(tx.error || req.error || new Error('曲を保存・復元できません'));
  });
}
J.projectAudio = {
  metadata(file, audio) {
    return { id: globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      name: file.name || 'song', type: file.type || 'application/octet-stream', size: file.size, duration: audio.duration };
  },
  store(meta, file) { return transaction('readwrite', store => store.put(file, meta.id)); },
  async read(meta) {
    const blob = await transaction('readonly', store => store.get(meta.id));
    return blob ? new File([blob], meta.name || 'song', { type: meta.type || blob.type }) : null;
  },
  async portable(project, file) {
    const copy = JSON.parse(JSON.stringify(project));
    delete copy.audioData;
    if (file) {
      const url = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(reader.error || new Error('曲を編集データに含められません'));
        reader.readAsDataURL(file);
      });
      copy.audioData = url.slice(url.indexOf(',') + 1);
    }
    return copy;
  },
  embeddedFile(project) {
    if (project.audioData == null) return null;
    if (typeof project.audioData !== 'string' || !project.audioAsset) throw new Error('曲のデータが壊れています');
    const raw = atob(project.audioData), bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
    if (!bytes.length || (project.audioAsset.size != null && bytes.length !== project.audioAsset.size)) throw new Error('曲のデータが不足しています');
    return new File([bytes], project.audioAsset.name || 'song', { type: project.audioAsset.type || 'application/octet-stream' });
  },
};
})();
