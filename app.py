import secrets
from flask import Flask, render_template, redirect, url_for
from flask_socketio import SocketIO, emit, join_room

app = Flask(__name__)
app.config['SECRET_KEY'] = 'subflow-simple'
socketio = SocketIO(app, cors_allowed_origins="*")

rooms_data = {}

@app.route('/')
def index():
    return render_template('index.html')

@app.route('/new_room')
def new_room():
    room_id = secrets.token_hex(4)
    rooms_data[room_id] = {
        'text': '',
        'font': '"DFKai-SB", "BiauKai", "標楷體", serif',
        'size': 36,
        'line': '1.0',
        'color': '#ffff33',
        'bg': '#121212'
    }
    return redirect(url_for('edit_room', room_id=room_id))

@app.route('/edit/<room_id>')
def edit_room(room_id):
    return render_template('edit.html', room_id=room_id)

@app.route('/view/<room_id>')
def view_room(room_id):
    return render_template('view.html', room_id=room_id)

@socketio.on('join')
def on_join(data):
    room = data['room']
    join_room(room)
    # 進房時回傳最新狀態
    current = rooms_data.get(room, {
        'text': '',
        'font': '"DFKai-SB", "BiauKai", "標楷體", serif',
        'size': 36,
        'line': '1.0',
        'color': '#ffff33',
        'bg': '#121212'
    })
    emit('sync_text', current)

@socketio.on('update_text')
def on_update_text(data):
    room = data['room']
    sync_style = data.get('sync_style', True)
    
    if room not in rooms_data:
        rooms_data[room] = {}
        
    # 文字一律全員即時同步
    rooms_data[room]['text'] = data.get('text', '')
    
    # 只有在開啟「投影廣播」時，才覆蓋全域樣式
    if sync_style:
        rooms_data[room]['font'] = data.get('font')
        rooms_data[room]['size'] = data.get('size')
        rooms_data[room]['line'] = data.get('line')
        rooms_data[room]['color'] = data.get('color')
        rooms_data[room]['bg'] = data.get('bg')

    # 廣播至全房間
    emit('sync_text', data, to=room, include_self=False)

if __name__ == '__main__':
    socketio.run(app, host='127.0.0.1', port=5000, debug=True)