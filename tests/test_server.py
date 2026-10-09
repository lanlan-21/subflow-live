import base64
import pytest
from pycrdt import Doc, Text
import app as server


@pytest.fixture(autouse=True)
def isolated(tmp_path, monkeypatch):
    monkeypatch.setattr(server, 'DB_PATH', str(tmp_path / 'test.sqlite3'))
    server.rooms.clear()
    server.members.clear()
    yield
    server.rooms.clear()
    server.members.clear()


def client(editor=True, room='meeting', cid=1):
    socket = server.socketio.test_client(server.app)
    result = socket.emit('join', dict(room=room, client_id=cid, is_editor=editor,
        token=server.signer.dumps({'room': room}) if editor else None), callback=True)
    assert 'state' in result
    return socket, result


def document(initial=b'\x00\x00'):
    doc = Doc()
    doc.apply_update(initial)
    return doc, doc.get('text', type=Text)


def send(socket, doc):
    return socket.emit('document_update', {'update': server.encode(doc.get_update())}, callback=True)


def test_concurrent_edits_and_duplicate_delivery():
    a, init = client(cid=1)
    b, _ = client(cid=2)
    da, ta = document(server.decode(init['state']))
    ta.insert(0, '現場發言🙂罕用𠮷字')
    assert send(a, da)['saved']
    db, tb = document(da.get_update())
    # Concurrent edits from the same base, including astral Unicode characters.
    ta.insert(0, '主持人：')
    tb.insert(len(tb), '補字')
    assert send(a, da)['saved']
    assert send(b, db)['saved']
    assert send(b, db)['saved']
    final = server.rooms['meeting']['doc'].get_update()
    da.apply_update(final)
    db.apply_update(final)
    assert str(ta) == str(tb)
    assert str(ta).count('補字') == 1
    assert '🙂罕用𠮷字' in str(ta)


def test_saved_document_survives_all_clients_leaving():
    a, _ = client()
    d, text = document()
    text.insert(0, '不可遺失的逐字稿')
    assert send(a, d)['saved']
    a.disconnect()
    assert 'meeting' not in server.rooms
    _, init = client(cid=2)
    _, restored = document(server.decode(init['state']))
    assert str(restored) == '不可遺失的逐字稿'


def test_viewer_cannot_write_or_claim_master():
    a, _ = client(cid=1)
    viewer, _ = client(editor=False, cid=2)
    d, text = document()
    text.insert(0, '偽造修改')
    assert 'error' in send(viewer, d)
    master = server.rooms['meeting']['master']
    viewer.emit('claim_master')
    assert server.rooms['meeting']['master'] == master
    assert str(server.rooms['meeting']['doc'].get('text', type=Text)) == ''


def test_editor_token_and_cross_room_isolation():
    socket = server.socketio.test_client(server.app)
    result = socket.emit('join', dict(room='meeting', is_editor=True, client_id=3,
        token=server.signer.dumps({'room': 'elsewhere'})), callback=True)
    assert 'error' in result
    a, _ = client(room='meeting', cid=1)
    b, _ = client(room='elsewhere', cid=2)
    d, text = document()
    text.insert(0, '只屬於 A')
    # The claimed room in an operation cannot override server-bound membership.
    a.emit('document_update', {'room': 'elsewhere', 'update': server.encode(d.get_update())}, callback=True)
    assert str(server.rooms['elsewhere']['doc'].get('text', type=Text)) == ''


def test_storage_failure_not_acknowledged_or_broadcast(monkeypatch):
    a, _ = client(cid=1)
    b, _ = client(cid=2)
    b.get_received()
    d, text = document()
    text.insert(0, '稍後重試')
    original = server.persist
    def fail(*args, **kwargs):
        raise OSError('Disk unavailable')
    monkeypatch.setattr(server, 'persist', fail)
    assert 'error' in send(a, d)
    assert not [e for e in b.get_received() if e['name'] == 'document_update']
    assert str(server.rooms['meeting']['doc'].get('text', type=Text)) == ''
    monkeypatch.setattr(server, 'persist', original)
    assert send(a, d)['saved']
    assert str(server.rooms['meeting']['doc'].get('text', type=Text)) == '稍後重試'


def test_revision_download_and_authentication():
    a, _ = client()
    d, text = document()
    text.insert(0, '版本一')
    assert send(a, d)['saved']
    http = server.app.test_client()
    assert http.get('/api/rooms/meeting/revisions').status_code == 403
    headers = {'X-Edit-Token': server.signer.dumps({'room': 'meeting'})}
    versions = http.get('/api/rooms/meeting/revisions', headers=headers).json
    assert len(versions) == 1
    response = http.get(f'/api/rooms/meeting/revisions/{versions[0]["id"]}', headers=headers)
    assert response.json['text'] == '版本一'


def test_presence_uses_server_bound_identity():
    a, _ = client(cid=123)
    b, _ = client(cid=456)
    b.get_received()
    a.emit('presence', {'client_id': 456, 'clock': 1, 'state': {'user': {'name': '甲'}}})
    event = next(e for e in b.get_received() if e['name'] == 'presence')
    assert event['args'][0]['client_id'] == 123


def test_invalid_update_does_not_corrupt_document():
    a, _ = client()
    d, text = document()
    text.insert(0, '原稿')
    assert send(a, d)['saved']
    assert 'error' in a.emit('document_update', {'update': 'invalid!'}, callback=True)
    assert str(server.rooms['meeting']['doc'].get('text', type=Text)) == '原稿'


def test_free_tier_storage_limit_is_disclosed(monkeypatch):
    monkeypatch.setattr(server, 'STORAGE_DURABLE', False)
    _, result = client()
    assert result['durable'] is False
    response = server.app.test_client().get('/healthz')
    assert response.status_code == 200
    assert response.json['durable_storage'] is False


def test_storage_health_check_detects_unavailable_database(monkeypatch):
    def fail():
        raise OSError('Unavailable storage')
    monkeypatch.setattr(server, 'database', fail)
    assert server.app.test_client().get('/healthz').status_code == 503
