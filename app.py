"""Durable single-process Yjs / Socket.IO collaboration server."""
import base64
import json
import os
import secrets
import sqlite3
import threading
import time
from contextlib import contextmanager
from pathlib import Path
from flask import Flask, abort, jsonify, redirect, render_template, request, url_for
from flask_socketio import SocketIO, emit, join_room, leave_room
from itsdangerous import URLSafeSerializer, BadSignature
from pycrdt import Doc, Text

DB_PATH = os.environ.get('SUBFLOW_DB', str(Path(__file__).parent / 'data' / 'subflow.sqlite3'))


def load_secret():
    if os.environ.get('SECRET_KEY'):
        return os.environ['SECRET_KEY']
    path = Path(DB_PATH).parent / '.editor-secret'
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        with path.open('x', encoding='ascii') as file:
            file.write(secrets.token_hex(32))
    except FileExistsError:
        pass
    return path.read_text(encoding='ascii')


app = Flask(__name__)
app.config['SECRET_KEY'] = load_secret()
socketio = SocketIO(app, async_mode='threading', ping_timeout=60, ping_interval=25, max_http_buffer_size=4 * 1024 * 1024)
signer = URLSafeSerializer(app.config['SECRET_KEY'], salt='subflow-editor-v2')
lock = threading.RLock()
rooms = {}
members = {}
DEFAULT_SETTINGS = dict(theme='dark', size=48, scale=100, pad_x=8, pad_y=10)
STORAGE_DURABLE = os.environ.get('SUBFLOW_DURABLE_STORAGE', '0' if os.environ.get('RENDER') else '1') == '1'


@contextmanager
def database():
    Path(DB_PATH).parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(DB_PATH, timeout=15)
    db.execute('PRAGMA journal_mode=WAL')
    db.execute('PRAGMA synchronous=FULL')
    db.execute('CREATE TABLE IF NOT EXISTS documents (room TEXT PRIMARY KEY, state BLOB NOT NULL, settings TEXT NOT NULL)')
    db.execute('CREATE TABLE IF NOT EXISTS revisions (id INTEGER PRIMARY KEY AUTOINCREMENT, room TEXT NOT NULL, state BLOB NOT NULL, created REAL NOT NULL)')
    db.execute('CREATE INDEX IF NOT EXISTS revisions_room ON revisions(room, id)')
    try:
        with db:
            yield db
    finally:
        db.close()


def get_room(room):
    if room not in rooms:
        doc = Doc(allow_multithreading=True)
        doc.get('text', type=Text)
        with database() as db:
            row = db.execute('SELECT state, settings FROM documents WHERE room=?', (room,)).fetchone()
        settings = dict(DEFAULT_SETTINGS)
        if row:
            doc.apply_update(bytes(row[0]))
            settings.update(json.loads(row[1]))
        rooms[room] = dict(doc=doc, settings=settings, editors={}, viewers=set(), master=None, last_snapshot=0)
    return rooms[room]


def persist(room, doc, settings, force_snapshot=False):
    # Only acknowledge an update after its database transaction commits.
    state = doc.get_update()
    now = time.time()
    snapshot = force_snapshot or now - rooms[room]['last_snapshot'] >= 60
    with database() as db:
        db.execute('INSERT INTO documents VALUES (?, ?, ?) ON CONFLICT(room) DO UPDATE SET state=excluded.state, settings=excluded.settings', (room, state, json.dumps(settings)))
        if snapshot:
            db.execute('INSERT INTO revisions(room, state, created) VALUES (?, ?, ?)', (room, state, now))
            db.execute('DELETE FROM revisions WHERE room=? AND id NOT IN (SELECT id FROM revisions WHERE room=? ORDER BY id DESC LIMIT 120)', (room, room))
    if snapshot:
        rooms[room]['last_snapshot'] = now


def encode(data):
    return base64.b64encode(data).decode('ascii')


def decode(data):
    if not isinstance(data, str) or len(data) > 5_600_000:
        raise ValueError('Invalid update size')
    return base64.b64decode(data, validate=True)


def valid_room(room):
    return isinstance(room, str) and 0 < len(room) <= 100 and '/' not in room


def authorized(room, token):
    try:
        return signer.loads(token) == {'room': room}
    except (BadSignature, TypeError):
        return False


@app.route('/')
def index():
    return render_template('index.html')


@app.route('/healthz')
def health():
    try:
        with database() as db:
            db.execute('SELECT 1').fetchone()
        return jsonify(status='ok', durable_storage=STORAGE_DURABLE)
    except Exception:
        return jsonify(status='storage_unavailable'), 503


@app.route('/edit/<room_id>')
def edit(room_id):
    if not valid_room(room_id):
        abort(400)
    # The edit URL is an invitation; it is deliberately separate from view URLs.
    return render_template('edit.html', room_id=room_id, edit_token=signer.dumps({'room': room_id}))


@app.route('/view/<room_id>')
def view(room_id):
    if not valid_room(room_id):
        abort(400)
    return render_template('view.html', room_id=room_id)


@app.route('/new_room')
def new_room():
    return redirect(url_for('edit', room_id=secrets.token_urlsafe(9)))


@app.route('/api/rooms/<room_id>/revisions')
def revisions(room_id):
    if not authorized(room_id, request.headers.get('X-Edit-Token')):
        abort(403)
    with database() as db:
        rows = db.execute('SELECT id, created FROM revisions WHERE room=? ORDER BY id DESC LIMIT 120', (room_id,)).fetchall()
    return jsonify([dict(id=row[0], created=row[1]) for row in rows])


@app.route('/api/rooms/<room_id>/revisions/<int:revision>')
def revision(room_id, revision):
    if not authorized(room_id, request.headers.get('X-Edit-Token')):
        abort(403)
    with database() as db:
        row = db.execute('SELECT state FROM revisions WHERE room=? AND id=?', (room_id, revision)).fetchone()
    if not row:
        abort(404)
    doc = Doc()
    doc.apply_update(bytes(row[0]))
    return jsonify(text=str(doc.get('text', type=Text)))


def broadcast_roles(room):
    r = rooms[room]
    socketio.emit('role_status_update', dict(master_client_id=r['master'], total_editors=len(r['editors']), total_viewers=len(r['viewers']), active_editors=list(r['editors'])), to=room)


def remove_member(sid):
    m = members.pop(sid, None)
    if not m:
        return
    room = m['room']
    r = rooms[room]
    if m['editor']:
        r['editors'].pop(sid, None)
        socketio.emit('presence_remove', {'client_id': m['client_id']}, to=room)
        if r['master'] == sid:
            r['master'] = next(iter(r['editors']), None)
    else:
        r['viewers'].discard(sid)
    broadcast_roles(room)
    if not r['editors'] and not r['viewers']:
        rooms.pop(room, None)  # Durable state remains on disk.


@socketio.on('join')
def handle_join(data):
    with lock:
        room = data.get('room') if isinstance(data, dict) else None
        if not valid_room(room):
            return {'error': '房間名稱不正確'}
        editor = data.get('is_editor') is True
        if editor and not authorized(room, data.get('token')):
            return {'error': '編輯授權失效，請重新整理頁面'}
        cid = data.get('client_id')
        if not isinstance(cid, int) or not 0 <= cid <= 2**53 - 1:
            return {'error': '協作身分不正確'}
        if request.sid in members:
            leave_room(members[request.sid]['room'])
            remove_member(request.sid)
        r = get_room(room)
        members[request.sid] = dict(room=room, editor=editor, client_id=cid, state=None)
        join_room(room)
        if editor:
            r['editors'][request.sid] = cid
            if r['master'] is None:
                r['master'] = request.sid
        else:
            r['viewers'].add(request.sid)
        broadcast_roles(room)
        return dict(state=encode(r['doc'].get_update()), settings=r['settings'], durable=STORAGE_DURABLE, peers=[dict(client_id=m['client_id'], state=m['state']) for m in members.values() if m['room'] == room and m['state'] is not None])


@socketio.on('document_update')
def handle_update(data):
    with lock:
        m = members.get(request.sid)
        if not m or not m['editor']:
            return {'error': '此連線沒有編輯權限'}
        r = rooms[m['room']]
        try:
            update = decode(data.get('update'))
            candidate = Doc(allow_multithreading=True)
            candidate.apply_update(r['doc'].get_update())
            candidate.apply_update(update)
            persist(m['room'], candidate, r['settings'], bool(data.get('snapshot')))
            r['doc'] = candidate
        except Exception:
            app.logger.exception('Document update rejected')
            return {'error': '儲存失敗，修改仍保留在此裝置，請重試'}
        emit('document_update', {'update': encode(update)}, to=m['room'], include_self=False)
        return {'saved': True}


@socketio.on('presence')
def handle_presence(data):
    with lock:
        m = members.get(request.sid)
        if not m or not m['editor'] or not isinstance(data, dict) or len(json.dumps(data)) > 8192:
            return
        m['state'] = data
        emit('presence', dict(client_id=m['client_id'], state=data), to=m['room'], include_self=False)


@socketio.on('claim_master')
def handle_claim_master(_data=None):
    with lock:
        m = members.get(request.sid)
        if m and m['editor']:
            rooms[m['room']]['master'] = request.sid
            broadcast_roles(m['room'])


@socketio.on('update_settings')
def handle_settings(data):
    with lock:
        m = members.get(request.sid)
        if not m or rooms[m['room']]['master'] != request.sid:
            return
        r = rooms[m['room']]
        settings = dict(r['settings'])
        if data.get('theme') in ('dark', 'green', 'navy', 'light'):
            settings['theme'] = data['theme']
        for key, bounds in dict(size=(12, 140), scale=(40, 250), pad_x=(0, 300), pad_y=(0, 300)).items():
            value = data.get(key)
            if isinstance(value, (int, float)) and bounds[0] <= value <= bounds[1]:
                settings[key] = value
        try:
            persist(m['room'], r['doc'], settings)
        except Exception:
            return {'error': '投影設定儲存失敗'}
        r['settings'] = settings
        emit('sync_settings', settings, to=m['room'], include_self=False)
        return {'saved': True}


@socketio.on('projection_scroll')
def handle_projection_scroll(data):
    with lock:
        m = members.get(request.sid)
        if not m or not m['editor'] or rooms[m['room']]['master'] != request.sid:
            return
        if not isinstance(data, dict) or type(data.get('index')) is not int or not 0 <= data['index'] <= 2**31 - 1:
            return
        projection = dict(index=data['index'], bottom=data.get('bottom') is True)
        rooms[m['room']]['projection'] = projection
        emit('projection_scroll', projection, to=m['room'], include_self=False)


@socketio.on('request_projection')
def handle_request_projection(_data=None):
    with lock:
        m = members.get(request.sid)
        if m:
            projection = rooms[m['room']].get('projection')
            if projection:
                emit('projection_scroll', projection)


@socketio.on('disconnect')
def handle_disconnect(_reason=None):
    with lock:
        remove_member(request.sid)


if __name__ == '__main__':
    socketio.run(app, host='0.0.0.0', port=int(os.environ.get('PORT', 5000)), debug=False, allow_unsafe_werkzeug=True)
