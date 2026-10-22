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
    result = socket.emit('join', dict(room=room, client_id=cid, is_editor=editor, protocol_version=2,
        token=server.signer.dumps({'room': room}) if editor else None), callback=True)
    assert 'state' in result
    return socket, result


def document(initial=b'\x00\x00'):
    doc = Doc()
    doc.apply_update(initial)
    return doc, doc.get('text', type=Text)


def send(socket, doc):
    return socket.emit('document_update', {'update': server.encode(doc.get_update())}, callback=True)


def test_only_current_master_controls_projection_and_room_isolation():
    master, _ = client(cid=101)
    partner, _ = client(cid=102)
    viewer, _ = client(editor=False, cid=103)
    other, _ = client(editor=False, room='other', cid=104)
    for c in (master, partner, viewer, other):
        c.get_received()
    master.emit('projection_scroll', {'index': 12, 'bottom': False})
    assert server.rooms['meeting']['projection']['index'] == 12
    assert any(e['name'] == 'projection_scroll' for e in viewer.get_received())
    assert not any(e['name'] == 'projection_scroll' for e in other.get_received())
    for c in (partner, viewer):
        c.emit('projection_scroll', {'index': 999, 'bottom': True})
    master.emit('projection_scroll', {'index': 'invalid'})
    assert server.rooms['meeting']['projection']['index'] == 12
    viewer.emit('request_projection')
    assert viewer.get_received()[-1]['args'][0]['index'] == 12
    partner.emit('claim_master')
    master.emit('projection_scroll', {'index': 13})
    partner.emit('projection_scroll', {'index': 20})
    assert server.rooms['meeting']['projection']['index'] == 20


def test_line_height_sync_validation_and_persistence():
    master, initial = client(cid=201)
    partner, _ = client(cid=202)
    viewer, _ = client(editor=False, cid=203)
    assert initial['settings']['line_height'] == 1.25
    for socket in (master, partner, viewer):
        socket.get_received()
    partner.emit('update_settings', {'line_height': 2})
    viewer.emit('update_settings', {'line_height': 2})
    assert server.rooms['meeting']['settings']['line_height'] == 1.25
    assert master.emit('update_settings', {'line_height': 1.30}, callback=True)['saved']
    for socket in (partner, viewer):
        assert any(event['name'] == 'sync_settings' and event['args'][0]['line_height'] == 1.30
                   for event in socket.get_received())
    for value in (0.9, 3.1, '2', float('nan'), float('inf')):
        master.emit('update_settings', {'line_height': value})
        assert server.rooms['meeting']['settings']['line_height'] == 1.30
    master.emit('update_settings', {'size': 50})  # An older client omits the new setting.
    late, joined = client(editor=False, cid=204)
    assert joined['settings']['line_height'] == 1.30
    for socket in (master, partner, viewer, late):
        socket.disconnect()
    server.rooms.clear()
    assert server.get_room('meeting')['settings']['line_height'] == 1.30


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


def test_projection_identity_is_shared_on_join_takeover_and_disconnect():
    master, first = client(cid=101)
    partner, second = client(cid=202)
    viewer, initial = client(editor=False, cid=303)
    assert first['master_doc_client_id'] == second['master_doc_client_id'] == initial['master_doc_client_id'] == 101
    viewer.get_received()
    partner.emit('claim_master')
    roles = [e for e in viewer.get_received() if e['name'] == 'role_status_update']
    assert roles[-1]['args'][0]['master_doc_client_id'] == 202
    _, late = client(editor=False, cid=404)
    assert late['master_doc_client_id'] == 202
    viewer.get_received()
    partner.disconnect()
    roles = [e for e in viewer.get_received() if e['name'] == 'role_status_update']
    assert roles[-1]['args'][0]['master_doc_client_id'] == 101


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


def test_editor_viewer_and_handshake_share_asset_version():
    _, result = client()
    http = server.app.test_client()
    assert result['asset_version'] == server.ASSET_VERSION
    assert http.get('/healthz').json['asset_version'] == server.ASSET_VERSION
    for route in ('/edit/meeting', '/view/meeting'):
        assert f'/static/collaboration.js?v={server.ASSET_VERSION}' in http.get(route).text


def test_compatible_legacy_clients_receive_snapshot_without_hash_block():
    writer, _ = client(cid=51)
    doc, text = document()
    text.insert(0, '加入即見最新稿')
    assert send(writer, doc)['saved']
    legacy = server.socketio.test_client(server.app)
    result = legacy.emit('join', dict(room='meeting', client_id=52, is_editor=False), callback=True)
    assert result['asset_version'] is None
    assert result['server_asset_version'] == server.ASSET_VERSION
    assert result['protocol_version'] == 2
    assert str(document(base64.b64decode(result['state']))[1]) == '加入即見最新稿'


def test_sync_document_repairs_missing_updates_and_keeps_projection():
    writer, _ = client(cid=61)
    viewer, _ = client(editor=False, cid=62)
    doc, text = document()
    text.insert(0, '第一版')
    assert send(writer, doc)['saved']
    local, _ = document(doc.get_update())
    text.insert(len(text), '與後續補字')
    assert send(writer, doc)['saved']
    writer.emit('projection_scroll', {'index': 2, 'bottom': False})
    result = viewer.emit('sync_document', {'state_vector': server.encode(local.get_state())}, callback=True)
    local.apply_update(base64.b64decode(result['state']))
    assert str(local.get('text', type=Text)) == '第一版與後續補字'
    assert result['projection']['index'] == 2
    outsider = server.socketio.test_client(server.app)
    assert outsider.emit('sync_document', {}, callback=True)['code'] == 'not_joined'


def test_duplicate_join_preserves_master_and_presence():
    first, _ = client(cid=71)
    second, _ = client(cid=72)
    second.emit('claim_master')
    first.emit('presence', {'clock': 1, 'state': {'user': {'name': '已加入'}}})
    result = first.emit('join', dict(room='meeting', client_id=71, is_editor=True, protocol_version=2,
                                   token=server.signer.dumps({'room': 'meeting'})), callback=True)
    assert result['master_doc_client_id'] == 72
    assert any(p['client_id'] == 71 and p['state']['state']['user']['name'] == '已加入' for p in result['peers'])


def test_session_renewal_and_entry_pages_are_not_cached():
    http = server.app.test_client()
    for path in ('/edit/meeting', '/view/meeting', '/api/rooms/meeting/session'):
        assert http.get(path).headers['Cache-Control'] == 'no-store'
    token = http.get('/api/rooms/meeting/session').json['token']
    assert server.authorized('meeting', token)
    assert not server.authorized('another-room', token)
    stale = server.socketio.test_client(server.app)
    assert stale.emit('join', dict(room='meeting', client_id=99, is_editor=True, token='expired', protocol_version=2), callback=True)['code'] == 'session_expired'
    assert 'state' in stale.emit('join', dict(room='meeting', client_id=99, is_editor=True, token=token, protocol_version=2), callback=True)


def test_storage_health_check_detects_unavailable_database(monkeypatch):
    def fail():
        raise OSError('Unavailable storage')
    monkeypatch.setattr(server, 'database', fail)
    assert server.app.test_client().get('/healthz').status_code == 503
