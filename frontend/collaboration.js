import * as Y from 'yjs';
import { QuillBinding } from 'y-quill';
import { IndexeddbPersistence } from 'y-indexeddb';
import { Awareness, applyAwarenessUpdate, removeAwarenessStates } from 'y-protocols/awareness';
import * as encoding from 'lib0/encoding';
import Quill from 'quill';
import QuillCursors from 'quill-cursors';
import { io } from 'socket.io-client';

window.Quill = Quill;
window.QuillCursors = QuillCursors;
window.io = io;

const encode = bytes => {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(binary);
};
const decode = data => Uint8Array.from(atob(data), char => char.charCodeAt(0));

window.createCollaboration = function ({ quill, socket, room, token, readOnly = false, onSettings = () => {}, onStatus = () => {} }) {
  const doc = new Y.Doc(); // A new ID for every document instance, including each tab.
  const text = doc.getText('text');
  const awareness = new Awareness(doc);
  const network = Symbol('network');
  let composing = false;
  let remoteQueue = [];
  let joined = false;
  let pending = [];
  let sending = false;
  let generation = 0;
  let timer;
  let ready = false;
  let backupReady = false;
  let durable = true;
  let localError = '';
  quill.enable(false);
  const binding = new QuillBinding(text, quill, awareness);
  const undo = new Y.UndoManager(text, { trackedOrigins: new Set([binding]), captureTimeout: 500 });
  // Quill's own history cannot distinguish Yjs transactions by collaborator.
  const history = quill.getModule('history');
  history.undo = () => undo.undo();
  history.redo = () => undo.redo();
  history.clear();
  // Quill captures bound history methods during construction, so replacing
  // history.undo alone does not replace Ctrl+Z / Ctrl+Shift+Z handlers.
  quill.root.addEventListener('keydown', event => {
    if (readOnly || event.isComposing || !(event.ctrlKey || event.metaKey) || event.altKey) return;
    const key = event.key.toLowerCase();
    if (key !== 'z' && key !== 'y') return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (key === 'y' || event.shiftKey) undo.redo();
    else undo.undo();
  }, true);
  quill.root.addEventListener('beforeinput', event => {
    if (readOnly || !['historyUndo', 'historyRedo'].includes(event.inputType)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (event.inputType === 'historyUndo') undo.undo();
    else undo.redo();
  }, true);
  const persistence = readOnly ? null : new IndexeddbPersistence(`subflow-v2:${room}`, doc);

  function status(message) {
    const clean = durable ? '所有修改已儲存' : readOnly ? '已同步；伺服器僅暫存' : '已同步至夥伴／本機備份；伺服器僅暫存';
    onStatus(message || (localError || (!joined ? '離線／重連中：修改尚未同步' : pending.length || sending ? '同步儲存中…' : clean)));
  }

  function receive(update) {
    if (composing) remoteQueue.push(update);
    else Y.applyUpdate(doc, update, network);
  }

  quill.root.addEventListener('compositionstart', () => {
    composing = true;
    undo.stopCapturing();
    awareness.setLocalStateField('composing', true);
  });
  quill.root.addEventListener('compositionend', () => {
    // Quill commits the final IME mutation before remote changes are applied.
    setTimeout(() => {
      quill.update('user');
      composing = false;
      const queue = remoteQueue;
      remoteQueue = [];
      doc.transact(() => queue.forEach(update => Y.applyUpdate(doc, update, network)), network);
      awareness.setLocalStateField('composing', false);
      undo.stopCapturing();
      schedule();
    }, 0);
  });

  function applyPresence(peer) {
    const writer = encoding.createEncoder();
    encoding.writeVarUint(writer, 1);
    encoding.writeVarUint(writer, peer.client_id);
    encoding.writeVarUint(writer, peer.state.clock);
    encoding.writeVarString(writer, JSON.stringify(peer.state.state));
    applyAwarenessUpdate(awareness, encoding.toUint8Array(writer), network);
  }

  function sendPresence() {
    if (joined && !readOnly) socket.emit('presence', {
      clock: awareness.meta.get(doc.clientID).clock,
      state: awareness.getLocalState()
    });
  }
  let presenceTimer;
  awareness.on('update', (_changes, origin) => {
    if (origin === network || readOnly) return;
    clearTimeout(presenceTimer);
    presenceTimer = setTimeout(sendPresence, 40);
  });
  const colors = ['#22c55e', '#38bdf8', '#e879f9', '#fb923c', '#a78bfa', '#facc15'];
  if (readOnly) awareness.setLocalState(null);
  else {
    const name = localStorage.getItem('subflow-name') || `聽打員 ${doc.clientID.toString().slice(-4)}`;
    awareness.setLocalStateField('user', { name, color: colors[doc.clientID % colors.length] });
  }

  function schedule(delay = 80) {
    clearTimeout(timer);
    timer = setTimeout(flush, delay);
  }

  function flush() {
    if (!joined || sending || !pending.length || composing || readOnly) return;
    const count = pending.length;
    const update = Y.mergeUpdates(pending.slice(0, count));
    const current = generation;
    sending = true;
    status();
    socket.timeout(10000).emit('document_update', { update: encode(update) }, (error, result) => {
      if (current !== generation) return;
      sending = false;
      if (error || !result?.saved) {
        status(result?.error || '儲存未確認：保留修改並重試中');
        schedule(2000);
        return;
      }
      pending.splice(0, count);
      status();
      schedule();
    });
  }

  doc.on('update', (update, origin) => {
    if (origin !== network && origin !== persistence && !readOnly) {
      pending.push(update);
      status();
      schedule();
    }
  });

  async function join() {
    if (!ready || !socket.connected) return;
    const current = ++generation;
    socket.timeout(10000).emit('join', { room, token, client_id: doc.clientID, is_editor: !readOnly }, (error, result) => {
      if (current !== generation) return;
      if (error || result?.error || !result?.state) {
        status(result?.error || '無法加入文件，正在重試');
        timer = setTimeout(join, 2000);
        return;
      }
      receive(decode(result.state));
      joined = true;
      durable = result.durable !== false;
      sending = false;
      // Re-send local state after every handshake. CRDT updates are idempotent;
      // this also recovers updates whose acknowledgement was lost or after reload.
      if (!readOnly) pending.push(Y.encodeStateAsUpdate(doc));
      result.peers.forEach(applyPresence);
      onSettings(result.settings);
      quill.enable(!readOnly);
      sendPresence();
      status();
      schedule(0);
    });
  }

  socket.on('connect', join);
  socket.on('disconnect', () => {
    generation++;
    joined = false;
    sending = false;
    removeAwarenessStates(awareness, [...awareness.getStates().keys()].filter(id => id !== doc.clientID), network);
    status();
  });
  socket.on('document_update', data => receive(decode(data.update)));
  socket.on('presence', applyPresence);
  socket.on('presence_remove', data => removeAwarenessStates(awareness, [data.client_id], network));
  socket.on('sync_settings', onSettings);

  if (persistence) {
    const backupTimeout = setTimeout(() => {
      localError = '本機備份尚未就緒，請勿關閉此頁';
      status();
    }, 8000);
    // whenSynced itself never rejects; include the initial database-open promise
    // so blocked/disabled IndexedDB produces an actionable status.
    Promise.all([persistence._db, persistence.whenSynced]).then(() => {
      clearTimeout(backupTimeout);
      backupReady = true;
      localError = '';
      ready = true;
      quill.enable(true);
      undo.clear();
      persistence.db.addEventListener('error', () => {
        backupReady = false;
        localError = '本機備份失敗：請保持此頁開啟並匯出';
        status();
      });
      join();
      status();
    }).catch(() => {
      clearTimeout(backupTimeout);
      localError = '本機備份無法使用：請保持此頁開啟並定期匯出';
      ready = true;
      join();
      status();
    });
  } else {
    ready = true;
    join();
  }

  window.addEventListener('beforeunload', event => {
    if (!readOnly && (pending.length || sending || composing || !backupReady)) {
      event.preventDefault();
      event.returnValue = '';
    }
  });

  return {
    doc, text, awareness, undo,
    setName(name) {
      name = name.trim().slice(0, 40);
      if (!name) return;
      localStorage.setItem('subflow-name', name);
      awareness.setLocalStateField('user', { ...awareness.getLocalState().user, name });
    },
    async clear() {
      if (composing || !joined || pending.length || sending) throw new Error('請等同步完成後再清空');
      // Preserve a revision immediately before a destructive shared edit.
      const result = await socket.timeout(10000).emitWithAck('document_update', { update: encode(Y.encodeStateAsUpdate(doc)), snapshot: true });
      if (!result?.saved) throw new Error('備份未完成，未清空文件');
      undo.stopCapturing();
      quill.deleteText(0, quill.getLength() - 1, 'user');
      undo.stopCapturing();
    },
    async revisions() {
      const response = await fetch(`/api/rooms/${encodeURIComponent(room)}/revisions`, { headers: { 'X-Edit-Token': token } });
      if (!response.ok) throw new Error('無法取得版本紀錄');
      return response.json();
    },
    async revision(id) {
      const response = await fetch(`/api/rooms/${encodeURIComponent(room)}/revisions/${id}`, { headers: { 'X-Edit-Token': token } });
      if (!response.ok) throw new Error('無法取得此版本');
      return (await response.json()).text;
    }
  };
};
