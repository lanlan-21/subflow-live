import os
import secrets
from flask import Flask, render_template, redirect, url_for, request
from flask_socketio import SocketIO, emit, join_room, leave_room

app = Flask(__name__)
app.config['SECRET_KEY'] = 'subflow-simple'
socketio = SocketIO(app, cors_allowed_origins="*", async_mode='threading')

DEFAULT_ROOM_CONFIG = {
    'text': '',
    'font': '"DFKai-SB", "BiauKai", "標楷體", serif',
    'size': 48,
    'line': '1.1',
    'color': '#ffff33',
    'bg': '#121212',
    'scale': 100,
    'pad_x': 8,
    'pad_y': 10,
    'master_sid': None
}

rooms_data = {
    'A': dict(DEFAULT_ROOM_CONFIG),
    'B': dict(DEFAULT_ROOM_CONFIG),
    'C': dict(DEFAULT_ROOM_CONFIG)
}

room_editors = {}

def get_room_id(raw_room):
    return str(raw_room).strip() if raw_room else 'A'

@app.route('/')
def index():
    return render_template('index.html')

@app.route('/new_room')
def new_room():
    room_id = secrets.token_hex(4)
    rooms_data[room_id] = dict(DEFAULT_ROOM_CONFIG)
    return redirect(url_for('edit_room', room_id=room_id))

@app.route('/edit/<room_id>')
def edit_room(room_id):
    r = get_room_id(room_id)
    if r not in rooms_data:
        rooms_data[r] = dict(DEFAULT_ROOM_CONFIG)
    return render_template('edit.html', room_id=r)

@app.route('/view/<room_id>')
def view_room(room_id):
    r = get_room_id(room_id)
    if r not in rooms_data:
        rooms_data[r] = dict(DEFAULT_ROOM_CONFIG)
    return render_template('view.html', room_id=r)

@app.route('/display/<room_id>')
def display_room(room_id):
    r = get_room_id(room_id)
    if r not in rooms_data:
        rooms_data[r] = dict(DEFAULT_ROOM_CONFIG)
    return render_template('display.html', room_id=r)

@socketio.on('join')
def on_join(data):
    room = get_room_id(data.get('room', 'A'))
    is_editor = data.get('is_editor', False)
    sid = request.sid

    join_room(room)

    if room not in rooms_data:
        rooms_data[room] = dict(DEFAULT_ROOM_CONFIG)
    if room not in room_editors:
        room_editors[room] = []

    if is_editor:
        if sid not in room_editors[room]:
            room_editors[room].append(sid)
        
        # 指派主投影
        if not rooms_data[room].get('master_sid') or rooms_data[room]['master_sid'] not in room_editors[room]:
            rooms_data[room]['master_sid'] = sid

        broadcast_roles(room)

    current_state = dict(rooms_data[room])
    emit('sync_text', current_state)

@socketio.on('disconnect')
def on_disconnect():
    sid = request.sid
    for room, editors in room_editors.items():
        if sid in editors:
            editors.remove(sid)
            if rooms_data[room].get('master_sid') == sid:
                rooms_data[room]['master_sid'] = editors[0] if editors else None
            broadcast_roles(room)
            # 廣播某位聽打員離線，清除其游標
            emit('cursor_remove', {'sid': sid}, to=room)
            break

@socketio.on('claim_master')
def on_claim_master(data):
    room = get_room_id(data.get('room'))
    sid = request.sid
    if room in rooms_data:
        rooms_data[room]['master_sid'] = sid
        broadcast_roles(room)

def broadcast_roles(room):
    emit('role_status_update', {
        'master_sid': rooms_data[room].get('master_sid'),
        'total_editors': len(room_editors.get(room, []))
    }, to=room)

@socketio.on('update_text')
def on_update_text(data):
    room = get_room_id(data.get('room', 'A'))
    sid = request.sid
    if room not in rooms_data:
        rooms_data[room] = dict(DEFAULT_ROOM_CONFIG)

    if 'text' in data:
        rooms_data[room]['text'] = data['text']

    cur_master = rooms_data[room].get('master_sid')
    is_master = (cur_master == sid) or (cur_master is None)

    if is_master:
        for k in ['font', 'size', 'line', 'color', 'bg', 'scale', 'pad_x', 'pad_y']:
            if k in data:
                rooms_data[room][k] = data[k]

    data['is_master'] = is_master
    data['sender_sid'] = sid  # 明確標註發送者 Socket ID
    emit('sync_text', data, to=room, include_self=False)

# 游標廣播：帶上真正的原生 sid
@socketio.on('cursor_move')
def on_cursor_move(data):
    room = get_room_id(data.get('room'))
    if room:
        data['sid'] = request.sid
        emit('cursor_update', data, to=room, include_self=False)

if __name__ == '__main__':
    port = int(os.environ.get("PORT", 10000))
    socketio.run(app, host='0.0.0.0', port=port, allow_unsafe_werkzeug=True)