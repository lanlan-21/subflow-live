import os
import uuid
from flask import Flask, render_template, request, redirect, session, url_for
from flask_socketio import SocketIO, emit, join_room, leave_room

app = Flask(__name__)
app.secret_key = os.environ.get("SECRET_KEY", "steno_private_secret_key_2026")

# 專屬管理密碼（支援由 Render 環境變數注入，預設 8888）
SITE_PASSWORD = os.environ.get("SITE_PASSWORD", "8888")

# 關閉持久化 Session：瀏覽器關閉即需重新驗證
app.config['SESSION_PERMANENT'] = False

socketio = SocketIO(app, cors_allowed_origins="*")

# 記憶體狀態追蹤
room_masters = {}   # room_id -> master_sid
room_editors = {}   # room_id -> set of editor sids

@app.before_request
def require_login():
    # 1. 靜態資源與登入頁全面放行
    if request.endpoint in ['login', 'static']:
        return None
    
    # 2. 觀眾投影看版全面免密碼放行
    if request.path.startswith('/view/'):
        return None
    
    # 3. 控制台與首頁驗證攔截
    if not session.get('authenticated'):
        # 排除 login 本身，只記錄使用者真實想造訪的頁面
        if request.endpoint != 'login':
            session['next_url'] = request.url
        return redirect(url_for('login'))

@app.route('/login', methods=['GET', 'POST'])
def login():
    error = None
    if request.method == 'POST':
        user_input_pass = request.form.get('password', '')
        if user_input_pass == SITE_PASSWORD:
            session['authenticated'] = True
            # 安全取得目標頁面，若沒有或目標是 login 就直接導回首頁，徹底解決轉跳迴圈
            next_page = session.pop('next_url', None)
            if not next_page or '/login' in next_page:
                next_page = url_for('index')
            return redirect(next_page)
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

@socketio.on('join')
def on_join(data):
    room = data.get('room')
    is_editor = data.get('is_editor', False)
    sid = request.sid

    join_room(room)

    if is_editor:
        if room not in room_editors:
            room_editors[room] = set()
        room_editors[room].add(sid)

        if room not in room_masters or room_masters[room] is None:
            room_masters[room] = sid

        broadcast_role_status(room)

@socketio.on('claim_master')
def on_claim_master(data):
    room = data.get('room')
    sid = request.sid
    if room in room_editors and sid in room_editors[room]:
        room_masters[room] = sid
        broadcast_role_status(room)

@socketio.on('update_text')
def on_update_text(data):
    room = data.get('room')
    sid = request.sid
    data['sender_sid'] = sid
    data['is_master'] = (room_masters.get(room) == sid)
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
