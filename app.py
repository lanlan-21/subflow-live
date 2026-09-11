import os
import uuid
from flask import Flask, render_template, request, redirect, session, url_for
from flask_socketio import SocketIO, emit, join_room, leave_room
from diff_match_patch import diff_match_patch

app = Flask(__name__)
app.secret_key = os.environ.get("SECRET_KEY", "steno_private_secret_key_2026")
SITE_PASSWORD = os.environ.get("SITE_PASSWORD", "8888")
app.config['SESSION_PERMANENT'] = False

socketio = SocketIO(app, cors_allowed_origins="*")

# 伺服器端單一真相來源（保證後登入者一定拿得到全文）
room_documents = {}  # room_id -> {"text": str, "version": int, "settings": dict}
room_masters = {}    # room_id -> master_sid
room_editors = {}    # room_id -> set of editor sids

dmp = diff_match_patch()

def get_room_doc(room_id):
    if room_id not in room_documents:
        room_documents[room_id] = {
            "text": "",
            "version": 0,
            "settings": {
                "size": 48,
                "scale": 100,
                "pad_x": 8,
                "pad_y": 10
            }
        }
    return room_documents[room_id]

@app.before_request
def require_login():
    if request.endpoint in ['login', 'static']:
        return None
    if request.path.startswith('/view/'):
        return None
    if not session.get('authenticated'):
        if request.endpoint and request.endpoint != 'login':
            session['next_url'] = request.path
        return redirect(url_for('login'))

@app.route('/login', methods=['GET', 'POST'])
def login():
    error = None
    if request.method == 'POST':
        user_input_pass = request.form.get('password', '')
        if user_input_pass == SITE_PASSWORD:
            session['authenticated'] = True
            target_path = session.pop('next_url', None)
            if not target_path or target_path == '/login':
                return redirect('/')
            return redirect(target_path)
        else:
            error = "密碼錯誤，請重新輸入！"
    return render_template('login.html', error=error)

@app.route('/')
def index():
    return render_template('index.html')

@app.route('/edit/<room_id>')
def edit_room(room_id):
    return render_template('edit.html', room_id=room_id)

@app.route('/view/<room_id>')
def view_room(room_id):
    return render_template('view.html', room_id=room_id)

@app.route('/new_room')
def new_room():
    unique_id = str(uuid.uuid4())[:8]
    return redirect(f'/edit/{unique_id}')

@app.errorhandler(404)
def page_not_found(e):
    return redirect('/')

@socketio.on('join')
def on_join(data):
    room = data.get('room')
    is_editor = data.get('is_editor', False)
    sid = request.sid

    join_room(room)
    doc = get_room_doc(room)

    if is_editor:
        if room not in room_editors:
            room_editors[room] = set()
        room_editors[room].add(sid)

        if room not in room_masters or room_masters[room] is None:
            room_masters[room] = sid

        broadcast_role_status(room)

    # 後登入者立即獲得伺服器最新全文與排版設定
    emit('init_document', {
        'text': doc['text'],
        'version': doc['version'],
        'settings': doc['settings']
    }, room=sid)

@socketio.on('claim_master')
def on_claim_master(data):
    room = data.get('room')
    sid = request.sid
    if room in room_editors and sid in room_editors[room]:
        room_masters[room] = sid
        broadcast_role_status(room)

@socketio.on('sync_text')
def on_sync_text(data):
    room = data.get('room')
    sid = request.sid
    doc = get_room_doc(room)
    
    incoming_text = data.get('text', '')
    patch_text = data.get('patch', '')
    
    # 權威合併更新
    if patch_text and patch_text.strip():
        try:
            patches = dmp.patch_fromText(patch_text)
            applied_text, _ = dmp.patch_apply(patches, doc['text'])
            doc['text'] = applied_text
        except Exception:
            doc['text'] = incoming_text
    else:
        doc['text'] = incoming_text

    doc['version'] += 1
    
    is_master = (room_masters.get(room) == sid)
    if is_master:
        if 'size' in data: doc['settings']['size'] = data['size']
        if 'scale' in data: doc['settings']['scale'] = data['scale']
        if 'pad_x' in data: doc['settings']['pad_x'] = data['pad_x']
        if 'pad_y' in data: doc['settings']['pad_y'] = data['pad_y']

    data['text'] = doc['text']
    data['sender_sid'] = sid
    data['is_master'] = is_master
    emit('sync_text', data, to=room, include_self=False)

@socketio.on('cursor_move')
def on_cursor_move(data):
    room = data.get('room')
    sid = request.sid
    emit('cursor_update', {
        'sid': sid,
        'cursor_index': data.get('cursor_index', 0)
    }, to=room, include_self=False)

@socketio.on('disconnect')
def on_disconnect():
    sid = request.sid
    for room, editors in list(room_editors.items()):
        if sid in editors:
            editors.remove(sid)
            emit('cursor_remove', {'sid': sid}, to=room)

            if room_masters.get(room) == sid:
                if len(editors) > 0:
                    room_masters[room] = next(iter(editors))
                else:
                    room_masters[room] = None

            broadcast_role_status(room)

def broadcast_role_status(room):
    total = len(room_editors.get(room, set()))
    master = room_masters.get(room)
    socketio.emit('role_status_update', {
        'master_sid': master,
        'total_editors': total
    }, to=room)

if __name__ == '__main__':
    port = int(os.environ.get('PORT', 10000))
    socketio.run(app, host='0.0.0.0', port=port, debug=False, allow_unsafe_werkzeug=True)
