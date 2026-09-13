import os
import random
import string
import threading
from flask import Flask, render_template, redirect, url_for, request
from flask_socketio import SocketIO, emit, join_room, leave_room

app = Flask(__name__)
app.config['SECRET_KEY'] = 'kaohsiung-transcription-secure-key-2026'

socketio = SocketIO(app, cors_allowed_origins="*", async_mode='threading')

rooms = {}
cleanup_timers = {}
CLEANUP_TIMEOUT_SECONDS = 1800  # 30 分鐘無人連線自動清理釋放記憶體


def schedule_room_cleanup(room_id):
    cancel_room_cleanup(room_id)

    def cleanup_job():
        if room_id in rooms:
            total_connected = len(rooms[room_id].get("editors", set())) + len(rooms[room_id].get("viewers", set()))
            if total_connected == 0:
                print(f"[自動清理] 房間 {room_id} 閒置達 30 分鐘，釋放記憶體。")
                rooms.pop(room_id, None)
        cleanup_timers.pop(room_id, None)

    timer = threading.Timer(CLEANUP_TIMEOUT_SECONDS, cleanup_job)
    timer.daemon = True
    cleanup_timers[room_id] = timer
    timer.start()


def cancel_room_cleanup(room_id):
    timer = cleanup_timers.pop(room_id, None)
    if timer:
        timer.cancel()


# 🌟 Google Docs 級原子轉換：嚴格保證字元自動向後推，絕不重疊覆蓋
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
            new_len = l1 - overlap
            if new_len <= 0:
                return None
            return {'type': 'delete', 'pos': min(p1, p2), 'len': new_len}

    return op1


def apply_op_to_text(text, op):
    if not op:
        return text
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
    sid = request.sid
    if not room_id:
        return

    cancel_room_cleanup(room_id)

    if room_id not in rooms:
        rooms[room_id] = {
            "text": "",
            "version": 0,
            "history": [],
            "settings": {"theme": "dark", "size": 48, "scale": 100, "pad_x": 8, "pad_y": 10},
            "master_sid": None,
            "editors": set(),
            "viewers": set()
        }

    join_room(room_id)

    if is_editor:
        rooms[room_id]["editors"].add(sid)
        if rooms[room_id]["master_sid"] is None:
            rooms[room_id]["master_sid"] = sid
    else:
        rooms[room_id]["viewers"].add(sid)

    emit('init_document', {
        "text": rooms[room_id]["text"],
        "version": rooms[room_id]["version"],
        "settings": rooms[room_id]["settings"]
    }, to=sid)

    broadcast_roles_status(room_id)


@socketio.on('client_operation')
def handle_client_operation(data):
    room_id = data.get('room')
    sid = request.sid
    if not room_id or room_id not in rooms:
        return

    cancel_room_cleanup(room_id)
    rdata = rooms[room_id]

    base_version = data.get('base_version', 0)
    raw_ops = data.get('ops', [])

    if data.get('is_clear'):
        rdata["text"] = ""
        rdata["version"] += 1
        rdata["history"].append({'version': rdata["version"], 'op': {'type': 'clear'}})
        emit('remote_operation', {
            'version': rdata["version"],
            'is_clear': True,
            'full_text': '',
            'sender_sid': sid
        }, to=room_id, include_self=False)
        emit('ack_operation', {'version': rdata["version"]}, to=sid)
        return

    ops = []
    for op in raw_ops:
        if op.get('type') == 'insert':
            op['text'] = op['text'].replace('\r\n', '\n').replace('\r', '\n')
        ops.append(op)

    transformed_ops = []
    for op in ops:
        curr = dict(op)
        for hist in rdata["history"]:
            if hist['version'] > base_version:
                if hist['op'].get('type') != 'clear':
                    curr = transform_primitive(curr, hist['op'], priority='right')
                    if curr is None:
                        break
        if curr:
            transformed_ops.append(curr)
            rdata["text"] = apply_op_to_text(rdata["text"], curr)
            rdata["version"] += 1
            rdata["history"].append({'version': rdata["version"], 'op': curr})

    if len(rdata["history"]) > 600:
        rdata["history"] = rdata["history"][-600:]

    emit('ack_operation', {'version': rdata["version"]}, to=sid)

    if transformed_ops:
        emit('remote_operation', {
            'version': rdata["version"],
            'ops': transformed_ops,
            'full_text': rdata["text"],
            'sender_sid': sid
        }, to=room_id, include_self=False)


# 🌟 即時組字幽靈串流：將正在按的注音或暫存字毫秒級廣播給大螢幕與協作端
@socketio.on('live_composing')
def handle_live_composing(data):
    room_id = data.get('room')
    sid = request.sid
    if room_id in rooms:
        emit('audience_live_composing', {
            'sid': sid,
            'composing_text': data.get('composing_text', '')
        }, to=room_id, include_self=False)


@socketio.on('update_settings')
def handle_update_settings(data):
    room_id = data.get('room')
    sid = request.sid
    if room_id in rooms and sid == rooms[room_id].get("master_sid"):
        rooms[room_id]["settings"]["theme"] = data.get('theme', 'dark')
        rooms[room_id]["settings"]["size"] = data.get('size', 48)
        rooms[room_id]["settings"]["scale"] = data.get('scale', 100)
        rooms[room_id]["settings"]["pad_x"] = data.get('pad_x', 8)
        rooms[room_id]["settings"]["pad_y"] = data.get('pad_y', 10)
        emit('sync_settings', rooms[room_id]["settings"], to=room_id, include_self=False)


@socketio.on('claim_master')
def handle_claim_master(data):
    room_id = data.get('room')
    sid = request.sid
    if room_id in rooms and sid in rooms[room_id]["editors"]:
        rooms[room_id]["master_sid"] = sid
        broadcast_roles_status(room_id)


@socketio.on('cursor_move')
def handle_cursor_move(data):
    room_id = data.get('room')
    sid = request.sid
    if room_id in rooms:
        emit('cursor_update', {
            'sid': sid,
            'cursor_index': data.get('cursor_index', 0),
            'typing_text': data.get('typing_text', '')
        }, to=room_id, include_self=False)


@socketio.on('disconnect')
def handle_disconnect():
    sid = request.sid
    for room_id, rdata in list(rooms.items()):
        modified = False

        if sid in rdata["editors"]:
            rdata["editors"].remove(sid)
            modified = True
            emit('cursor_remove', {'sid': sid}, to=room_id)

            if rdata["master_sid"] == sid:
                rdata["master_sid"] = next(iter(rdata["editors"])) if rdata["editors"] else None

        if sid in rdata["viewers"]:
            rdata["viewers"].remove(sid)
            modified = True

        if modified:
            broadcast_roles_status(room_id)
            total_active = len(rdata["editors"]) + len(rdata["viewers"])
            if total_active == 0:
                schedule_room_cleanup(room_id)


def broadcast_roles_status(room_id):
    if room_id not in rooms:
        return
    rdata = rooms[room_id]
    socketio.emit('role_status_update', {
        "master_sid": rdata["master_sid"],
        "total_editors": len(rdata["editors"]),
        "total_viewers": len(rdata["viewers"])
    }, to=room_id)


if __name__ == '__main__':
    port = int(os.environ.get('PORT', 5000))
    socketio.run(app, host='0.0.0.0', port=port, debug=False, allow_unsafe_werkzeug=True)
