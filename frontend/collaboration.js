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
// Use capabilities rather than device names: Safari on older iPads exposes
// prefixed methods, while an iPhone/embedded browser may expose neither.
window.createViewerFullscreen = () => ({
  get supported() {
    return !!((document.fullscreenEnabled && document.documentElement.requestFullscreen) ||
      (document.webkitFullscreenEnabled !== false && document.documentElement.webkitRequestFullscreen));
  },
  get active() { return !!(document.fullscreenElement || document.webkitFullscreenElement); },
  async enter() {
    const root = document.documentElement;
    if (document.fullscreenEnabled && root.requestFullscreen) await root.requestFullscreen();
    else if (document.webkitFullscreenEnabled !== false && root.webkitRequestFullscreen) await root.webkitRequestFullscreen();
    else throw new Error('Fullscreen unavailable');
  },
  async exit() {
    if (document.fullscreenElement && document.exitFullscreen) await document.exitFullscreen();
    else if (document.webkitFullscreenElement && document.webkitExitFullscreen) await document.webkitExitFullscreen();
  }
});
const runtimeVersion = new URL(document.currentScript?.src || window.location.href).searchParams.get('v');

// A Parchment leaf, like Quill's zero-length cursor, participates in layout but
// has no document offset or Delta content. Render through CSS so native copy,
// DOM-based IME fallback and text exports cannot pick up a partner's preedit.
const { EmbedBlot } = Quill.import('parchment');
class RemotePreedit extends EmbedBlot {
  static blotName = 'remote-preedit';
  static className = 'remote-ime-preview';
  static tagName = 'SPAN';
  static value() { return undefined; }
  length() { return 0; }
  value() { return ''; }
  html() { return ''; }
  index() { return 0; }
}

const encode = bytes => {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(binary);
};
const decode = data => Uint8Array.from(atob(data), char => char.charCodeAt(0));

// Share a text anchor and its position inside the visible viewport. Document
// bottom and scroll percentages are not equivalent across different wrapping.
window.captureProjection = (quill, container, collaboration) => {
  const editor = quill.container;
  const top = container.getBoundingClientRect().top - editor.getBoundingClientRect().top;
  const height = container.clientHeight;
  const last = Math.max(0, quill.getLength() - 1);
  let low = 0, high = last;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (quill.getBounds(mid).top < top - 1) low = mid + 1;
    else high = mid;
  }
  let index = low;
  const bottom = container.scrollHeight - container.scrollTop - height < 40;
  if (bottom) {
    // Ignore trailing empty paragraphs when choosing what the audience sees.
    const meaningful = Math.max(0, quill.getText().trimEnd().length - 1);
    const bounds = quill.getBounds(meaningful);
    index = meaningful;
  }
  const bounds = quill.getBounds(index);
  const viewport_y = bottom && (bounds.bottom <= top || bounds.top >= top + height)
    ? 0.65 : Math.max(0, Math.min(0.85, (bounds.top - top) / Math.max(1, height)));
  return { index, bottom, viewport_y, anchor: collaboration.projectionAnchor(index) };
};

window.applyProjection = (quill, container, projection, collaboration, spacer) => {
  if (!projection) return false;
  let index = projection.anchor ? collaboration.resolveProjectionAnchor(projection.anchor) : projection.index;
  // An anchor may arrive before the corresponding document update. Wait for it
  // rather than clamping it to unrelated text and jumping again on delivery.
  if (index == null || index >= quill.getLength()) return false;
  index = Math.max(0, index);
  if (spacer) spacer.style.height = container.clientHeight + 'px';
  const bounds = quill.getBounds(index);
  const offset = quill.container.getBoundingClientRect().top - container.getBoundingClientRect().top;
  const y = Number.isFinite(projection.viewport_y) ? projection.viewport_y : 0;
  container.scrollTop += offset + bounds.top - y * container.clientHeight;
  return true;
};

window.createCollaboration = function ({ quill, socket, room, token, readOnly = false, onSettings = () => {}, onStatus = () => {}, onComposition = () => {}, onPeerComposition = () => {}, onPreviewChange = () => {}, onProjection = () => {} }) {
  const doc = new Y.Doc(); // A new ID for every document instance, including each tab.
  const text = doc.getText('text');
  const imeCommits = doc.getMap('imeCommits');
  const awareness = new Awareness(doc);
  const network = Symbol('network');
  let composing = false;
  let compositionGeneration = 0;
  let compositionAnchor = null;
  let compositionOriginal = '';
  let compositionEnding = false;
  let compositionSafeUpdates = new Set();
  const compositionEvents = {};
  let remoteQueue = [];
  let joined = false;
  let pending = [];
  let sending = false;
  let generation = 0;
  let timer;
  let flushDue = 0;
  let joinTimer;
  let joinPending = false;
  let resyncPending = false;
  let ready = false;
  let backupReady = false;
  let durable = true;
  let localError = '';
  let projectionClientId = null;
  quill.scroll.registry.register(RemotePreedit);
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

  function publishComposition(value, source = 'compositionupdate') {
    if (readOnly || !composing || compositionEnding || !compositionAnchor) return;
    compositionEvents[source] = (compositionEvents[source] || 0) + 1;
    const draft = typeof value === 'string' ? value.slice(0, 512) : '';
    const previous = awareness.getLocalState()?.compositionPreview;
    onComposition({ active: true, text: draft, source, events: { ...compositionEvents } });
    if (previous?.text === draft) return;
    awareness.setLocalStateField('compositionPreview', {
      anchor: compositionAnchor, text: draft
    });
  }
  quill.root.addEventListener('compositionstart', () => {
    if (readOnly) return;
    compositionGeneration++;
    compositionEnding = false;
    // Only updates completed before this IME session can be flushed during it.
    // Otherwise its anchor can refer to text that peers have never received.
    compositionSafeUpdates = new Set(pending);
    composing = true;
    const range = quill.getSelection();
    compositionOriginal = quill.root.textContent.replace(/\uFEFF/g, '');
    compositionAnchor = Y.createRelativePositionFromTypeIndex(text, Math.min(range?.index ?? text.length, text.length));
    undo.stopCapturing();
    awareness.setLocalStateField('composing', true);
    publishComposition('', 'compositionstart');
    schedule(0);
  });
  quill.root.addEventListener('compositionupdate', event => publishComposition(event.data));
  quill.root.addEventListener('beforeinput', event => {
    if (composing && event.inputType === 'insertCompositionText' && typeof event.data === 'string') {
      publishComposition(event.data, 'beforeinput');
    }
  });
  quill.root.addEventListener('input', event => {
    if (!composing || !(event.isComposing || event.inputType === 'insertCompositionText')) return;
    if (typeof event.data === 'string') publishComposition(event.data, 'input');
    else {
      // Some IMEs expose preedit DOM mutations without CompositionEvent.data.
      const current = quill.root.textContent.replace(/\uFEFF/g, '');
      let start = 0, end = 0;
      while (start < compositionOriginal.length && start < current.length && compositionOriginal[start] === current[start]) start++;
      while (end < compositionOriginal.length - start && end < current.length - start && compositionOriginal[compositionOriginal.length - end - 1] === current[current.length - end - 1]) end++;
      const draft = current.slice(start, current.length - end);
      if (draft || current !== compositionOriginal) publishComposition(draft, 'input-dom');
    }
  });
  quill.root.addEventListener('compositionend', event => {
    if (readOnly) return;
    const currentComposition = compositionGeneration;
    compositionEnding = true;
    const preview = awareness.getLocalState()?.compositionPreview;
    const finalText = typeof event.data === 'string' ? event.data.slice(0, 512) : '';
    onComposition({ active: false, events: { ...compositionEvents } });
    // Quill commits the final IME mutation before remote changes are applied.
    setTimeout(() => {
      if (currentComposition !== compositionGeneration) return;
      quill.update('user');
      composing = false;
      compositionEnding = false;
      compositionAnchor = null;
      compositionSafeUpdates.clear();
      // A numeric marker shares the document update with inserts AND deletes.
      // A state vector alone cannot fence deletion-only replacements.
      if (finalText && preview) imeCommits.set(String(doc.clientID), currentComposition);
      // Presence is faster than document saves. Retire the inline preedit only
      // once the receiver has this exact committed CRDT state, never on Enter
      // alone. Send this fence before flushing the corresponding document update.
      awareness.setLocalStateField('compositionCommit', finalText && preview ? {
        client: doc.clientID, sequence: currentComposition,
        preview: { anchor: preview.anchor, text: finalText }
      } : awareness.getLocalState()?.compositionCommit || null);
      awareness.setLocalStateField('compositionPreview', null);
      awareness.setLocalStateField('composing', false);
      sendPresence();
      const queue = remoteQueue;
      remoteQueue = [];
      doc.transact(() => queue.forEach(update => Y.applyUpdate(doc, update, network)), network);
      renderCompositionPreviews();
      undo.stopCapturing();
      schedule(0);
    }, 0);
  });
  quill.root.addEventListener('blur', () => {
    // Native candidate windows can temporarily take focus during composition.
    if (!readOnly && !composing) awareness.setLocalStateField('compositionPreview', null);
  });

  // Transient inline leaves push the following characters aside without
  // inserting text into Quill's Delta, Yjs, persistence or undo history.
  const previewNodes = new Map();
  {
    const style = document.createElement('style');
    style.textContent = '.remote-ime-preview{display:inline;pointer-events:none;user-select:none;-webkit-user-select:none;background:transparent;border:0;padding:0;box-shadow:none;color:inherit;font:inherit;white-space:pre-wrap;overflow-wrap:anywhere}.remote-ime-preview::before{content:attr(data-preview)}';
    document.head.append(style);
  }
  let previewFrame;
  function notifyPeerCompositions() {
    if (readOnly) return;
    const peers = [];
    const versions = [];
    awareness.getStates().forEach((state, id) => {
      if (id === doc.clientID) return;
      if (state.user) versions.push({ id, version: state.clientVersion || null, current: state.clientVersion === runtimeVersion });
      if (!state.composing || !state.compositionPreview) return;
      peers.push({ id, name: String(state.user?.name || '夥伴').slice(0, 40),
        text: typeof state.compositionPreview.text === 'string' ? state.compositionPreview.text.slice(0, 512) : '' });
    });
    // This view is independent of anchors and each collaborator's scroll position.
    onPeerComposition(peers, { versions });
  }
  function renderCompositionPreviews(immediate = false) {
    if (immediate === true) {
      if (previewFrame) cancelAnimationFrame(previewFrame);
      drawCompositionPreviews();
    } else if (!previewFrame) previewFrame = requestAnimationFrame(drawCompositionPreviews);
  }
  function drawCompositionPreviews() {
      previewFrame = null;
      // Never split or remove DOM nodes underneath this user's native IME.
      // The independent status still receives presence during local composition.
      if (composing) return;
      const active = new Set();
      const selection = quill.hasFocus() ? quill.getSelection() : null;
      let changed = false;
      let layoutChanged = false;
      awareness.getStates().forEach((state, id) => {
        if (id === doc.clientID) return;
        // Audience mirrors the server-selected projection master, rather than
        // exposing every corrector's unconfirmed IME to the audience.
        if (readOnly && id !== projectionClientId) return;
        try {
          let preview = state.composing ? state.compositionPreview : null;
          if (state.compositionCommit) {
            const { client, sequence } = state.compositionCommit;
            if (Number.isSafeInteger(client) && Number.isSafeInteger(sequence) &&
                (imeCommits.get(String(client)) || 0) < sequence) {
              preview = state.compositionCommit.preview;
            }
          }
          if (!preview) return;
          const anchor = Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(preview.anchor), doc);
          if (!anchor || anchor.type !== text) return;
          const draft = typeof preview.text === 'string' ? preview.text.slice(0, 512) : '';
          if (!draft) return;
          const index = Math.min(anchor.index, quill.getLength() - 1);
          active.add(id);
          let blot = previewNodes.get(id);
          if (!blot?.parent || blot.offset(quill.scroll) !== index) {
            if (blot?.parent) blot.remove();
            blot = quill.scroll.create('remote-preedit');
            const [leaf, offset] = quill.getLeaf(index);
            if (!leaf) return;
            const parent = leaf.parent;
            const ref = leaf.split(offset);
            parent.insertBefore(blot, ref);
            previewNodes.set(id, blot);
            changed = true;
          }
          const node = blot.domNode;
          node.contentEditable = 'false';
          node.dataset.clientId = String(id);
          const name = String(state.user?.name || '夥伴').slice(0, 40);
          if (node.dataset.preview !== draft) { node.dataset.preview = draft; layoutChanged = true; }
          node.setAttribute('aria-label', `${name}正在組字：${draft}`);
        } catch { /* A deleted or malformed anchor has no safe preview position. */ }
      });
      for (const [id, blot] of previewNodes) {
        if (!active.has(id)) { blot.remove(); previewNodes.delete(id); changed = true; }
      }
      if (changed) {
        quill.update('silent');
        if (selection) quill.setSelection(selection, 'silent');
      }
      quill.getModule('cursors')?.update();
      if (changed || layoutChanged) onPreviewChange();
  }
  // Yjs observers have already updated Quill here. Remove a completed preview
  // in the same JavaScript task, before a frame can paint both copies.
  doc.on('afterTransaction', transaction => {
    if (transaction.origin === network) renderCompositionPreviews(true);
  });
  awareness.on('change', renderCompositionPreviews);
  awareness.on('change', notifyPeerCompositions);
  quill.on('editor-change', renderCompositionPreviews);
  window.addEventListener('resize', renderCompositionPreviews);

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
    // Throttle with a trailing latest state; continuous typing must not defer it.
    if (presenceTimer) return;
    presenceTimer = setTimeout(() => { presenceTimer = null; sendPresence(); }, 16);
  });
  const colors = ['#22c55e', '#38bdf8', '#e879f9', '#fb923c', '#a78bfa', '#facc15'];
  if (readOnly) awareness.setLocalState(null);
  else {
    awareness.setLocalStateField('clientVersion', runtimeVersion);
    const name = localStorage.getItem('subflow-name') || `聽打員 ${doc.clientID.toString().slice(-4)}`;
    awareness.setLocalStateField('user', { name, color: colors[doc.clientID % colors.length] });
  }

  function schedule(delay = 16) {
    const due = Date.now() + delay;
    // A bounded throttle: a continuous stream must not postpone every save.
    if (timer && flushDue <= due) return;
    clearTimeout(timer);
    flushDue = due;
    timer = setTimeout(() => { timer = null; flush(); }, delay);
  }

  function retryJoin(delay = 2000) {
    clearTimeout(joinTimer);
    joinTimer = setTimeout(join, delay);
  }

  function flush() {
    if (!joined || sending || !pending.length || readOnly) return;
    let count = pending.length;
    if (composing) {
      count = 0;
      while (count < pending.length && compositionSafeUpdates.has(pending[count])) count++;
      if (!count) return;
    }
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
      schedule(0);
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
    if (!ready || !socket.connected || joinPending) return;
    clearTimeout(joinTimer);
    joinPending = true;
    const current = ++generation;
    socket.timeout(10000).emit('join', { room, token, client_id: doc.clientID, is_editor: !readOnly, protocol_version: 2 }, async (error, result) => {
      if (current !== generation) return;
      joinPending = false;
      if (!error && result?.code === 'session_expired' && !readOnly) {
        status('正在恢復編輯連線；本機修改仍保留');
        try {
          const response = await fetch(`/api/rooms/${encodeURIComponent(room)}/session`, { cache: 'no-store' });
          if (!response.ok) throw new Error('Session unavailable');
          const session = await response.json();
          if (current !== generation) return;
          if (typeof session.token !== 'string') throw new Error('Session unavailable');
          token = session.token;
          retryJoin(0);
        } catch { if (current === generation) retryJoin(); }
        return;
      }
      if (error || result?.error || !result?.state) {
        status(result?.error || '無法加入文件，正在重試');
        retryJoin();
        return;
      }
      if (result.protocol_version && result.protocol_version !== 2) {
        status('共筆服務正在更新，保留本機內容並嘗試重連');
        retryJoin();
        return;
      }
      projectionClientId = Number.isSafeInteger(result.master_doc_client_id) ? result.master_doc_client_id : null;
      receive(decode(result.state));
      joined = true;
      durable = result.durable !== false;
      sending = false;
      // Re-send local state after every handshake. CRDT updates are idempotent;
      // this also recovers updates whose acknowledgement was lost or after reload.
      if (!readOnly) pending.push(Y.encodeStateAsUpdate(doc));
      result.peers.forEach(applyPresence);
      onSettings(result.settings);
      if (result.projection) onProjection(result.projection);
      quill.enable(!readOnly);
      sendPresence();
      status();
      schedule(0);
    });
  }

  socket.on('connect', join);
  socket.on('request_sync', () => { schedule(0); sendPresence(); });
  socket.on('role_status_update', data => {
    projectionClientId = Number.isSafeInteger(data.master_doc_client_id) ? data.master_doc_client_id : null;
    renderCompositionPreviews(true);
  });
  socket.on('disconnect', () => {
    generation++;
    joined = false;
    sending = false;
    joinPending = false;
    resyncPending = false;
    clearTimeout(joinTimer);
    removeAwarenessStates(awareness, [...awareness.getStates().keys()].filter(id => id !== doc.clientID), network);
    status();
  });
  socket.on('document_update', data => receive(decode(data.update)));
  socket.on('presence', applyPresence);
  socket.on('presence_remove', data => removeAwarenessStates(awareness, [data.client_id], network));
  socket.on('sync_settings', onSettings);

  function reconcile() {
    if (!joined || !socket.connected || resyncPending) return;
    const current = generation;
    resyncPending = true;
    socket.timeout(10000).emit('sync_document', { state_vector: encode(Y.encodeStateVector(doc)) }, (error, result) => {
      if (current !== generation) return;
      resyncPending = false;
      if (result?.code === 'not_joined') { joined = false; join(); return; }
      if (error || !result?.state) return;
      receive(decode(result.state));
      projectionClientId = Number.isSafeInteger(result.master_doc_client_id) ? result.master_doc_client_id : null;
      result.peers?.forEach(applyPresence);
      onSettings(result.settings);
      if (result.projection) onProjection(result.projection);
      renderCompositionPreviews();
      schedule(0);
    });
  }
  // Repair missed broadcasts and browser suspension without reloading the page.
  setInterval(() => { if (document.visibilityState === 'visible') reconcile(); }, 5000);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') reconcile(); });
  window.addEventListener('pageshow', reconcile);

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
    projectionAnchor(index) {
      return encode(Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(text, Math.min(index, text.length))));
    },
    resolveProjectionAnchor(anchor) {
      try {
        const position = Y.createAbsolutePositionFromRelativePosition(Y.decodeRelativePosition(decode(anchor)), doc);
        return position?.type === text ? position.index : null;
      } catch { return null; }
    },
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
