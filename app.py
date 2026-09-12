import os
import random
import string
import threading
from flask import Flask, render_template, redirect, url_for, request
from flask_socketio import SocketIO, emit, join_room, leave_room

app = Flask(__name__)
app.config['SECRET_KEY'] = 'kaohsiung-transcription-secure-key-2026'

socketio = SocketIO(app, cors_allowed_origins="*", async_mode='threading')

# 記憶體資料庫結構增加 version 定序
# rooms[room_id] = {
#     "text": "",
#     "version": 0,
#     "settings": {"size": 48, "scale": 100, "pad_x": 8, "pad_y": 10},
#     "master_sid": None,
#     "editors": set(),
#     "viewers": set()
# }
rooms = {}

cleanup_timers = {}
CLEANUP_TIMEOUT_SECONDS = 1800  # 30 分鐘


def schedule_room_cleanup(room_id):
    cancel_room_cleanup(room_id)

    def cleanup_job():
        if room_id in rooms:
            total_connected = len(rooms[room_id].get("editors", set())) + len(rooms[room_id].get("viewers", set()))
            if total_connected == 0:
                print(f"[自動清理] 房間 {room_id} 閒置達 30 分鐘，清空記憶體。")
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
            "settings": {"size": 48, "scale": 100, "pad_x": 8, "pad_y": 10},
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


@socketio.on('sync_text')
def handle_sync_text(data):
    room_id = data.get('room')
    sid = request.sid

    if not room_id or room_id not in rooms:
        return

    cancel_room_cleanup(room_id)

    # 伺服器原子遞增版本號
    rooms[room_id]["version"] += 1
    server_version = rooms[room_id]["version"]
    
    new_text = data.get('text', '')
    rooms[room_id]["text"] = new_text

    is_master = (sid == rooms[room_id].get("master_sid"))
    if is_master:
        rooms[room_id]["settings"]["size"] = data.get('size', 48)
        rooms[room_id]["settings"]["scale"] = data.get('scale', 100)
        rooms[room_id]["settings"]["pad_x"] = data.get('pad_x', 8)
        rooms[room_id]["settings"]["pad_y"] = data.get('pad_y', 10)

    data['version'] = server_version
    data['sender_sid'] = sid
    data['is_master'] = is_master

    # 廣播給同房間其他人
    emit('sync_text', data, to=room_id, include_self=False)


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
            'cursor_index': data.get('cursor_index', 0)
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
