import os
import random
import string
import threading
from flask import Flask, render_template, redirect, url_for, request
from flask_socketio import SocketIO, emit, join_room, leave_room

app = Flask(__name__)
app.config['SECRET_KEY'] = 'kaohsiung-transcription-secure-key-2026'

# 加入心跳容錯參數，防止會場網路瞬斷導致不同步
socketio = SocketIO(app, cors_allowed_origins="*", async_mode='threading', ping_timeout=60, ping_interval=25)

rooms = {}
room_locks = {} # 🌟 企業級房間鎖，消滅並發時空錯亂
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

def transform_primitive(op1, op2, priority):
    if not op1 or not op2:
        return op1
    t1, p1 = op1['type'], op1['pos']
    t2, p2 = op2['type'], op2['pos']

    if t1 == 'insert' and t2 == 'insert':
        l2 = len(op2['text'])
        if p1 < p2 or (p1 == p2 and priority == 'left'):
            return {'type': 'insert', 'pos': p1, 'text': op1['text']}
        else:
            return {'type': 'insert', 'pos': p1 + l2, 'text': op1['text']}
    elif t1 == 'insert' and t2 == 'delete':
        l2 = op2['len']
        if p1 <= p2:
            return {'type': 'insert', 'pos': p1, 'text': op1['text']}
        elif p1 >= p2 + l2:
            return {'type': 'insert', 'pos': p1 - l2, 'text': op1['text']}
        else:
            return {'type': 'insert', 'pos': p2, 'text': op1['text']}
    elif t1 == 'delete' and t2 == 'insert':
        l1 = op1['len']
        l2 = len(op2['text'])
        if p1 + l1 <= p2:
            return {'type': 'delete', 'pos': p1, 'len': l1}
        elif p1 >= p2:
            return {'type': 'delete', 'pos': p1 + l2, 'len': l1}
        else:
            return {'type': 'delete', 'pos': p1, 'len': l1 + l2}
    elif t1 == 'delete' and t2 == 'delete':
        l1, l2 = op1['len'], op2['len']
        if p1 + l1 <= p2:
            return {'type': 'delete', 'pos': p1, 'len': l1}
        elif p1 >= p2 + l2:
            return {'type': 'delete', 'pos': p1 - l2, 'len': l1}
        else:
            start = max(p1, p2)
            end = min(p1 + l1, p2 + l2)
            overlap = end - start
            if l1 - overlap <= 0: return None
            return {'type': 'delete', 'pos': min(p1, p2), 'len': l1 - overlap}
    return op1

def apply_op_to_text(text, op):
    if not op: return text
    if op['type'] == 'insert':
        p = min(max(0, op['pos']), len(text))
        return text[:p] + op['text'] + text[p:]
    elif op['type'] == 'delete':
        p = min(max(0, op['pos']), len(text))
        l = op['len']
        return text[:p] + text[p+l:]
    return text

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
                "text": "\n", "version": 0, "history": [],
                "settings": {"theme": "dark", "size": 48, "scale": 100, "pad_x": 8, "pad_y": 10},
                "master_client_id": None, "editors": {}, "viewers": set(),
                "cached_delta": None 
            }

        join_room(room_id)

        if is_editor:
            rooms[room_id]["editors"][client_id] = sid
            if rooms[room_id]["master_client_id"] is None:
                rooms[room_id]["master_client_id"] = client_id
                emit('init_document', {'delta': None, 'settings': rooms[room_id]["settings"]}, to=sid)
            else:
                master_sid = rooms[room_id]["editors"].get(rooms[room_id]["master_client_id"])
                if master_sid:
                    emit('request_full_document', {'target_sid': sid}, to=master_sid)
                else:
                    emit('init_document', {'delta': rooms[room_id]["cached_delta"], 'settings': rooms[room_id]["settings"]}, to=sid)
        else:
            rooms[room_id]["viewers"].add(sid)
            master_sid = rooms[room_id]["editors"].get(rooms[room_id]["master_client_id"])
            if master_sid:
                emit('request_full_document', {'target_sid': sid}, to=master_sid)
            else:
                emit('init_document', {'delta': rooms[room_id]["cached_delta"], 'settings': rooms[room_id]["settings"]}, to=sid)

    broadcast_roles_status(room_id)

@socketio.on('sync_full_document')
def handle_sync_full_document(data):
    room_id = data.get('room')
    target_sid = data.get('target_sid')
    delta = data.get('delta')
    if not room_id: return
    
    with room_locks.get(room_id, threading.Lock()):
        if room_id in rooms:
            rooms[room_id]['cached_delta'] = delta
            if target_sid:
                emit('init_document', {'delta': delta, 'settings': rooms[room_id]['settings']}, to=target_sid)

@socketio.on('client_operation')
def handle_client_operation(data):
    room_id = data.get('room')
    client_id = data.get('client_id') or request.sid
    sid = request.sid
    if not room_id or room_id not in rooms: return

    cancel_room_cleanup(room_id)
    
    # 🌟 嚴格鎖定執行緒，保證 10 萬字極限下封包絕對不亂序
    with room_locks.get(room_id, threading.Lock()):
        rdata = rooms[room_id]
        base_version = data.get('base_version', 0)
        raw_ops = data.get('ops', [])

        if data.get('is_clear'):
            rdata["text"] = "\n"
            rdata["version"] += 1
            rdata["history"].append({'version': rdata["version"], 'ops': [{'type': 'clear'}]})
            rdata["cached_delta"] = None
            emit('remote_operation', {'version': rdata["version"], 'is_clear': True, 'client_id': client_id}, to=room_id, include_self=False)
            emit('ack_operation', {'version': rdata["version"]}, to=sid)
            return

        ops = []
        for op in raw_ops:
            if op.get('type') == 'insert':
                op['text'] = op['text'].replace('\r\n', '\n').replace('\r', '\n')
            ops.append(op)

        transformed_batch = []
        for op in ops:
            curr = dict(op)
            for hist in rdata["history"]:
                if hist['version'] > base_version:
                    for hist_op in hist['ops']:
                        if hist_op.get('type') != 'clear':
                            curr = transform_primitive(curr, hist_op, priority='right')
                            if curr is None: break
                    if curr is None: break
            if curr:
                transformed_batch.append(curr)
                rdata["text"] = apply_op_to_text(rdata["text"], curr)

        if transformed_batch:
            rdata["version"] += 1
            rdata["history"].append({'version': rdata["version"], 'ops': transformed_batch})
            if len(rdata["history"]) > 600: rdata["history"] = rdata["history"][-600:]

            emit('ack_operation', {'version': rdata["version"]}, to=sid)
            emit('remote_operation', {
                'version': rdata["version"], 'ops': transformed_batch,
                'client_id': client_id
            }, to=room_id, include_self=False)
        else:
            emit('ack_operation', {'version': rdata["version"]}, to=sid)

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
