import os
import random
import string
import threading
from flask import Flask, render_template, redirect, url_for, request
from flask_socketio import SocketIO, emit, join_room, leave_room

app = Flask(__name__)
app.config['SECRET_KEY'] = 'kaohsiung-transcription-secure-key-2026'

# 心跳檢測防禦網路瞬斷
socketio = SocketIO(app, cors_allowed_origins="*", async_mode='threading', ping_timeout=60, ping_interval=25)

rooms = {}
room_locks = {}
cleanup_timers = {}
CLEANUP_TIMEOUT_SECONDS = 1800 

def schedule_room_cleanup(room_id):
    cancel_room_cleanup(room_id)
    def cleanup_job():
        with room_locks.get(room_id, threading.Lock()):
            if room_id in rooms:
                total_connected = len(rooms[room_id].get("editors", {})) + len(rooms[room_id].get("viewers", set()))
                if total_connected == 0:
                    rooms.pop(room_id, None)
                    room_locks.pop(room_id, None)
        cleanup_timers.pop(room_id, None)
    timer = threading.Timer(CLEANUP_TIMEOUT_SECONDS, cleanup_job)
    timer.daemon = True
    cleanup_timers[room_id] = timer
    timer.start()

def cancel_room_cleanup(room_id):
    timer = cleanup_timers.pop(room_id, None)
    if timer:
        timer.cancel()

# 🌟 神級輕量運算：用最穩定的方式將 Delta 寫入純文字，確保新加入的觀眾瞬間獲得 10 萬字完整內容
def apply_delta_to_text(text, delta):
    pos = 0
    new_text = ""
    for op in delta.get('ops', []):
        if 'retain' in op:
            retain_len = op['retain']
            new_text += text[pos:pos+retain_len]
            pos += retain_len
        elif 'insert' in op:
            ins = op['insert']
            if isinstance(ins, str):
                new_text += ins
        elif 'delete' in op:
            pos += op['delete']
    new_text += text[pos:]
    return new_text

@app.route('/')
def index():
    return render_template('index.html')

@app.route('/edit/<room_id>')
def edit(room_id):
    return render_template('edit.html', room_id=room_id)

@app.route('/view/<room_id>')
def view(room_id):
    return render_template('view.html', room_id=room_id)

@app.route('/new_room')
def new_room():
    random_str = ''.join(random.choices(string.ascii_uppercase + string.digits, k=6))
    return redirect(url_for('edit', room_id=random_str))

@socketio.on('join')
def handle_join(data):
    room_id = data.get('room')
    is_editor = data.get('is_editor', False)
    client_id = data.get('client_id') or request.sid
    sid = request.sid
    if not room_id: return

    cancel_room_cleanup(room_id)
    
    if room_id not in room_locks:
        room_locks[room_id] = threading.Lock()

    with room_locks[room_id]:
        if room_id not in rooms:
            rooms[room_id] = {
                "text": "\n", "version": 0, 
                "settings": {"theme": "dark", "size": 48, "scale": 100, "pad_x": 8, "pad_y": 10},
                "master_client_id": None, "editors": {}, "viewers": set()
            }

        join_room(room_id)

        if is_editor:
            rooms[room_id]["editors"][client_id] = sid
            if rooms[room_id]["master_client_id"] is None:
                rooms[room_id]["master_client_id"] = client_id
        else:
            rooms[room_id]["viewers"].add(sid)

        # 無論何時加入，伺服器永遠擁有絕對正確的 10 萬字純文字備份
        emit('init_document', {
            "text": rooms[room_id]["text"],
            "version": rooms[room_id]["version"],
            "settings": rooms[room_id]["settings"]
        }, to=sid)

    broadcast_roles_status(room_id)

# 🌟 極速郵差：不再做陣列比對，只要版本正確就光速廣播，把碰撞交給終端的 Quill 引擎
@socketio.on('client_operation')
def handle_client_operation(data):
    room_id = data.get('room')
    client_id = data.get('client_id')
    base_version = data.get('base_version', 0)
    delta = data.get('delta')
    
    if not room_id or room_id not in rooms: return

    with room_locks.get(room_id, threading.Lock()):
        rdata = rooms[room_id]
        
        if data.get('is_clear'):
            rdata["text"] = "\n"
            rdata["version"] += 1
            emit('remote_operation', {'version': rdata["version"], 'is_clear': True, 'client_id': client_id}, to=room_id)
            return

        # 版本吻合，光速放行
        if base_version == rdata["version"]:
            rdata["text"] = apply_delta_to_text(rdata["text"], delta)
            rdata["version"] += 1
            
            emit('remote_operation', {
                'version': rdata["version"],
                'delta': delta,
                'client_id': client_id
            }, to=room_id)
        # 如果版本不吻合，伺服器安靜地拋棄。客戶端的「智能自癒引擎」會在收到下一個廣播時自動修復重傳。

@socketio.on('cursor_move')
def handle_cursor_move(data):
    room_id = data.get('room')
    emit('cursor_update', data, to=room_id, include_self=False)

@socketio.on('update_settings')
def handle_update_settings(data):
    room_id = data.get('room')
    client_id = data.get('client_id')
    with room_locks.get(room_id, threading.Lock()):
        if room_id in rooms and client_id == rooms[room_id].get("master_client_id"):
            rooms[room_id]["settings"]["theme"] = data.get('theme', 'dark')
            rooms[room_id]["settings"]["size"] = data.get('size', 48)
            rooms[room_id]["settings"]["scale"] = data.get('scale', 100)
            rooms[room_id]["settings"]["pad_x"] = data.get('pad_x', 8)
            rooms[room_id]["settings"]["pad_y"] = data.get('pad_y', 10)
            emit('sync_settings', rooms[room_id]["settings"], to=room_id, include_self=False)

@socketio.on('claim_master')
def handle_claim_master(data):
    room_id = data.get('room')
    client_id = data.get('client_id')
    with room_locks.get(room_id, threading.Lock()):
        if room_id in rooms and client_id in rooms[room_id]["editors"]:
            rooms[room_id]["master_client_id"] = client_id
            broadcast_roles_status(room_id)

@socketio.on('disconnect')
def handle_disconnect():
    sid = request.sid
    for room_id, rdata in list(rooms.items()):
        with room_locks.get(room_id, threading.Lock()):
            modified = False
            disconnected_cid = None
            for cid, csid in list(rdata["editors"].items()):
                if csid == sid:
                    disconnected_cid = cid
                    break
            if disconnected_cid:
                rdata["editors"].pop(disconnected_cid, None)
                modified = True
                emit('cursor_remove', {'client_id': disconnected_cid}, to=room_id)
                if rdata["master_client_id"] == disconnected_cid:
                    rdata["master_client_id"] = next(iter(rdata["editors"])) if rdata["editors"] else None
            if sid in rdata["viewers"]:
                rdata["viewers"].remove(sid)
                modified = True
            if modified:
                broadcast_roles_status(room_id)
                if len(rdata["editors"]) + len(rdata["viewers"]) == 0:
                    schedule_room_cleanup(room_id)

def broadcast_roles_status(room_id):
    if room_id not in rooms: return
    rdata = rooms[room_id]
    active_cids = list(rdata["editors"].keys())
    socketio.emit('role_status_update', {
        "master_client_id": rdata["master_client_id"], "total_editors": len(active_cids),
        "active_editors": active_cids, "total_viewers": len(rdata["viewers"])
    }, to=room_id)

if __name__ == '__main__':
    port = int(os.environ.get('PORT', 5000))
    socketio.run(app, host='0.0.0.0', port=port, debug=False, allow_unsafe_werkzeug=True)
