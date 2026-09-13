import os
import random
import string
import threading
from flask import Flask, render_template, redirect, url_for, request
from flask_socketio import SocketIO, emit, join_room, leave_room

app = Flask(__name__)
app.config['SECRET_KEY'] = 'kaohsiung-transcription-secure-key-2026'

socketio = SocketIO(app, cors_allowed_origins="*", async_mode='threading')

# 伺服器端資料庫：保存全域文字、版本、OT 歷史隊列與房間設定
rooms = {}

cleanup_timers = {}
CLEANUP_TIMEOUT_SECONDS = 1800  # 30 分鐘無人連線自動清理釋放記憶體


def schedule_room_cleanup(room_id):
    cancel_room_cleanup(room_id)

    def cleanup_job():
        if room_id in rooms:
            total_connected = len(rooms[room_id].get("editors", set())) + len(rooms[room_id].get("viewers", set()))
            if total_connected == 0:
                print(f"[自動清理] 房間 {room_id} 閒置達 30 分鐘，清空記憶體釋放資源。")
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


# 🌟 Google Docs 級 OT（Operational Transformation）演算法
def transform_op(op, against):
    t_type = op['type']
    a_type = against['type']

    if t_type == 'insert' and a_type == 'insert':
        pos = op['pos']
        if against['pos'] <= pos:
            return {'type': 'insert', 'pos': pos + len(against['text']), 'text': op['text']}
        return op

    elif t_type == 'insert' and a_type == 'delete':
        pos = op['pos']
        del_pos = against['pos']
        del_len = against['len']
        if pos <= del_pos:
            return op
        elif pos >= del_pos + del_len:
            return {'type': 'insert', 'pos': pos - del_len, 'text': op['text']}
        else:
            return {'type': 'insert', 'pos': del_pos, 'text': op['text']}

    elif t_type == 'delete' and a_type == 'insert':
        pos = op['pos']
        del_len = op['len']
        ins_pos = against['pos']
        ins_len = len(against['text'])
        if pos >= ins_pos:
            return {'type': 'delete', 'pos': pos + ins_len, 'len': del_len}
        elif pos + del_len <= ins_pos:
            return op
        else:
            return {'type': 'delete', 'pos': pos, 'len': del_len + ins_len}

    elif t_type == 'delete' and a_type == 'delete':
        pos1, len1 = op['pos'], op['len']
        pos2, len2 = against['pos'], against['len']
        if pos1 + len1 <= pos2:
            return op
        elif pos1 >= pos2 + len2:
            return {'type': 'delete', 'pos': pos1 - len2, 'len': len1}
        else:
            overlap_start = max(pos1, pos2)
            overlap_end = min(pos1 + len1, pos2 + len2)
            overlap_len = max(0, overlap_end - overlap_start)
            new_len = len1 - overlap_len
            new_pos = min(pos1, pos2)
            if new_len <= 0:
                return None
            return {'type': 'delete', 'pos': new_pos, 'len': new_len}
    return op


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
            "settings": {"size": 48, "scale": 100, "pad_x": 8, "pad_y": 10},
            "master_sid": None,
            "editors": set(),
            "viewers": set()
        }

    join_room(room_id)

    # 嚴格區分身分：只有工作台協作員才能成為 master_sid，大螢幕絕對為純唯讀
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
            'sender_sid': sid
        }, to=room_id, include_self=False)
        emit('ack_operation', {'version': rdata["version"]}, to=sid)
        return

    # 換行統一標準化為單一字元 \n，長度索引零誤差
    ops = []
    for op in raw_ops:
        if op.get('type') == 'insert':
            op['text'] = op['text'].replace('\r\n', '\n').replace('\r', '\n')
        ops.append(op)

    transformed_ops = []
    for op in ops:
        current_op = dict(op)
        for hist in rdata["history"]:
            if hist['version'] > base_version:
                if hist['op'].get('type') != 'clear':
                    current_op = transform_op(current_op, hist['op'])
                    if current_op is None:
                        break
        if current_op:
            transformed_ops.append(current_op)
            rdata["text"] = apply_op_to_text(rdata["text"], current_op)
            rdata["version"] += 1
            rdata["history"].append({'version': rdata["version"], 'op': current_op})

    if len(rdata["history"]) > 500:
        rdata["history"] = rdata["history"][-500:]

    emit('ack_operation', {'version': rdata["version"]}, to=sid)

    if transformed_ops:
        emit('remote_operation', {
            'version': rdata["version"],
            'ops': transformed_ops,
            'sender_sid': sid
        }, to=room_id, include_self=False)


@socketio.on('update_settings')
def handle_update_settings(data):
    room_id = data.get('room')
    sid = request.sid
    if room_id in rooms and sid == rooms[room_id].get("master_sid"):
        rooms[room_id]["settings"]["size"] = data.get('size', 48)
        rooms[room_id]["settings"]["scale"] = data.get('scale', 100)
        rooms[room_id]["settings"]["pad_x"] = data.get('pad_x', 8)
        rooms[room_id]["settings"]["pad_y"] = data.get('pad_y', 10)
        # 廣播大螢幕與搭檔同步縮放
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
