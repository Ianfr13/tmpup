import asyncio
import base64
import json
import re
import time
import uuid
import pytest
from fastapi.testclient import TestClient

from app import (
    BASE_URL,
    FileMetadata,
    _file_meta_dict,
    _get_file_info,
    _list_active_files,
    api_list_files,
    app,
    delete_file,
    delete_file_by_id,
    delete_file_endpoint,
    extend_file_ttl,
    extend_ttl,
    get_file,
    get_file_info,
    get_file_paths,
    list_files,
    log_event,
    mcp,
    patch_file_ttl,
    upload_file,
    validate_ttl,
)


def test_validate_ttl_valid():
    assert validate_ttl(0) == 0
    assert validate_ttl(1) == 1
    assert validate_ttl(3600) == 3600
    assert validate_ttl(31536000) == 31536000


def test_validate_ttl_invalid():
    with pytest.raises(ValueError):
        validate_ttl(-1)

    with pytest.raises(ValueError):
        validate_ttl(31536001)

    with pytest.raises(ValueError):
        validate_ttl("invalid")


def test_validate_ttl_rejects_bool_and_float():
    with pytest.raises(ValueError, match="TTL must be a valid integer"):
        validate_ttl(True)

    with pytest.raises(ValueError, match="TTL must be a valid integer"):
        validate_ttl(False)

    with pytest.raises(ValueError, match="TTL must be a valid integer"):
        validate_ttl(3.9)

    with pytest.raises(ValueError, match="TTL must be a valid integer"):
        validate_ttl(1.0)


@pytest.fixture(autouse=True)
def isolate_data_dir(tmp_path, monkeypatch):
    data_dir = tmp_path / "data"
    data_dir.mkdir()
    import app
    monkeypatch.setattr(app, "DATA_DIR", data_dir)
    return data_dir


def test_list_active_files(isolate_data_dir):
    assert _list_active_files() == []

    # File 1: active image
    meta1 = FileMetadata(
        file_id="id-1",
        filename="test1.png",
        ttl=3600,
        created_at=time.time() - 100,
    )
    meta1.save(isolate_data_dir / "id-1.meta.json")
    (isolate_data_dir / "id-1").write_bytes(b"content1")

    # File 2: active text (newer)
    meta2 = FileMetadata(
        file_id="id-2",
        filename="test2.txt",
        ttl=0,
        created_at=time.time() - 10,
    )
    meta2.save(isolate_data_dir / "id-2.meta.json")
    (isolate_data_dir / "id-2").write_bytes(b"content2")

    # File 3: expired
    meta3 = FileMetadata(
        file_id="id-3",
        filename="test3.txt",
        ttl=10,
        created_at=time.time() - 1000,
    )
    meta3.save(isolate_data_dir / "id-3.meta.json")
    (isolate_data_dir / "id-3").write_bytes(b"content3")

    files = _list_active_files()
    assert len(files) == 2
    # Sorted by created_at desc -> id-2 first, then id-1
    assert files[0]["id"] == "id-2"
    assert files[0]["filename"] == "test2.txt"
    assert files[0]["is_image"] is False
    assert files[0]["expires_in"] == -1
    assert "url" in files[0]
    assert "view_url" in files[0]

    assert files[1]["id"] == "id-1"
    assert files[1]["filename"] == "test1.png"
    assert files[1]["is_image"] is True

def test_get_file_info_existing_and_missing(isolate_data_dir):
    assert _get_file_info("non-existent") is None

    active_id = str(uuid.uuid4())
    # Create active file
    meta = FileMetadata(
        file_id=active_id,
        filename="photo.jpg",
        ttl=1800,
        created_at=time.time(),
    )
    meta.save(isolate_data_dir / f"{active_id}.meta.json")
    (isolate_data_dir / active_id).write_bytes(b"image-data")

    info = _get_file_info(active_id)
    assert info is not None
    assert info["id"] == active_id
    assert info["filename"] == "photo.jpg"
    assert info["is_image"] is True
    assert 0 <= info["expires_in"] <= 1800
    assert "url" in info
    assert "view_url" in info

    exp_id = str(uuid.uuid4())
    # Create expired file
    meta_exp = FileMetadata(
        file_id=exp_id,
        filename="old.txt",
        ttl=10,
        created_at=time.time() - 50,
    )
    meta_exp.save(isolate_data_dir / f"{exp_id}.meta.json")
    (isolate_data_dir / exp_id).write_bytes(b"old-data")

    assert _get_file_info(exp_id) is None


def test_log_event(capsys):
    log_event("test_event", foo="bar", num=123)
    captured = capsys.readouterr().out
    data = json.loads(captured.strip())
    assert data == {"svc": "tmpup", "event": "test_event", "foo": "bar", "num": 123}


def test_delete_file_by_id(isolate_data_dir, capsys):
    assert delete_file_by_id("missing-id") is False
    captured = capsys.readouterr().out
    data = json.loads(captured.strip())
    assert data["svc"] == "tmpup"
    assert data["event"] == "file_delete_failed"
    assert data["file_id"] == "missing-id"

    del_id = str(uuid.uuid4())
    # Create file and metadata
    file_path = isolate_data_dir / del_id
    meta_path = isolate_data_dir / f"{del_id}.meta.json"
    file_path.write_bytes(b"content")
    meta = FileMetadata(del_id, "test.txt", 3600, time.time())
    meta.save(meta_path)

    assert delete_file_by_id(del_id) is True
    assert not file_path.exists()
    assert not meta_path.exists()

    captured = capsys.readouterr().out
    data = json.loads(captured.strip())
    assert data["svc"] == "tmpup"
    assert data["event"] == "file_deleted"
    assert data["file_id"] == del_id


def test_delete_file_by_id_propagates_unexpected_exception(isolate_data_dir, monkeypatch):
    valid_id = str(uuid.uuid4())
    file_path = isolate_data_dir / valid_id
    meta_path = isolate_data_dir / f"{valid_id}.meta.json"
    file_path.write_bytes(b"content")
    meta = FileMetadata(valid_id, "test.txt", 3600, time.time())
    meta.save(meta_path)

    def mock_unlink(self):
        raise PermissionError("Permission denied: simulated delete failure")

    monkeypatch.setattr("pathlib.Path.unlink", mock_unlink)

    with pytest.raises(PermissionError, match="Permission denied"):
        delete_file_by_id(valid_id)


def test_extend_file_ttl_not_found(isolate_data_dir, capsys):
    res = extend_file_ttl("non-existent-id", 3600)
    assert res is None
    captured = capsys.readouterr().out
    data = json.loads(captured.strip())
    assert data["svc"] == "tmpup"
    assert data["event"] == "extend_ttl_failed"
    assert data["file_id"] == "non-existent-id"
    assert data["reason"] == "not_found"


def test_extend_file_ttl_invalid_ttl(isolate_data_dir, capsys):
    ext_id = str(uuid.uuid4())
    meta = FileMetadata(ext_id, "doc.txt", 100, time.time() - 50)
    meta.save(isolate_data_dir / f"{ext_id}.meta.json")
    (isolate_data_dir / ext_id).write_bytes(b"content")

    with pytest.raises(ValueError):
        extend_file_ttl(ext_id, -5)

    captured = capsys.readouterr().out
    assert "extend_ttl_failed" in captured


def test_extend_file_ttl_success(isolate_data_dir, capsys):
    old_time = time.time() - 50
    ext_id2 = str(uuid.uuid4())
    meta = FileMetadata(ext_id2, "doc.txt", 100, old_time)
    meta.save(isolate_data_dir / f"{ext_id2}.meta.json")
    (isolate_data_dir / ext_id2).write_bytes(b"content")

    updated = extend_file_ttl(ext_id2, 7200)
    assert updated is not None
    assert updated["id"] == ext_id2
    assert updated["filename"] == "doc.txt"
    assert updated["created_at"] > old_time
    assert updated["expires_in"] > 7000

    # Verify saved on disk
    reloaded = FileMetadata.from_file(isolate_data_dir / f"{ext_id2}.meta.json")
    assert reloaded.ttl == 7200
    assert reloaded.created_at == updated["created_at"]

    captured = capsys.readouterr().out
    data = json.loads(captured.strip())
    assert data["svc"] == "tmpup"
    assert data["event"] == "extend_ttl_success"
    assert data["file_id"] == ext_id2
    assert data["ttl"] == 7200


def test_extend_file_ttl_expired_file(isolate_data_dir, auth_client):
    expired_id = str(uuid.uuid4())
    # Expired file: ttl=10, created 100 seconds ago
    meta = FileMetadata(expired_id, "expired.txt", 10, time.time() - 100)
    meta.save(isolate_data_dir / f"{expired_id}.meta.json")
    (isolate_data_dir / expired_id).write_bytes(b"expired-content")

    # 1. Helper extend_file_ttl returns None
    res = extend_file_ttl(expired_id, 3600)
    assert res is None

    # Verify metadata on disk was not updated
    reloaded = FileMetadata.from_file(isolate_data_dir / f"{expired_id}.meta.json")
    assert reloaded.ttl == 10
    assert reloaded.is_expired is True

    # 2. MCP tool extend_ttl raises ValueError
    with pytest.raises(ValueError):
        extend_ttl(expired_id, 3600)

    # 3. REST endpoint returns 404
    res_patch = auth_client.patch(f"/api/files/{expired_id}/ttl", json={"ttl": 3600})
    assert res_patch.status_code == 404

@pytest.fixture
def auth_client(monkeypatch):
    monkeypatch.setattr("app.API_KEYS", {"test-key"})
    return TestClient(app, headers={"X-API-Key": "test-key"})


def test_rest_get_file_info(auth_client, isolate_data_dir):
    res = auth_client.get("/api/files/missing-123")
    assert res.status_code == 404

    file_abc = str(uuid.uuid4())
    # Create file
    meta = FileMetadata(file_abc, "image.png", 3600, time.time())
    meta.save(isolate_data_dir / f"{file_abc}.meta.json")
    (isolate_data_dir / file_abc).write_bytes(b"content")

    res = auth_client.get(f"/api/files/{file_abc}")
    assert res.status_code == 200
    data = res.json()
    assert data["id"] == file_abc
    assert data["filename"] == "image.png"
    assert data["is_image"] is True


def test_rest_delete_file(auth_client, isolate_data_dir):
    res = auth_client.delete("/api/files/missing-del")
    assert res.status_code == 404

    file_del = str(uuid.uuid4())
    # Create file
    meta = FileMetadata(file_del, "temp.txt", 3600, time.time())
    meta.save(isolate_data_dir / f"{file_del}.meta.json")
    (isolate_data_dir / file_del).write_bytes(b"delme")

    res = auth_client.delete(f"/api/files/{file_del}")
    assert res.status_code == 200
    assert res.json() == {"deleted": True}
    assert not (isolate_data_dir / file_del).exists()
    assert not (isolate_data_dir / f"{file_del}.meta.json").exists()


def test_rest_patch_file_ttl(auth_client, isolate_data_dir):
    # 404 for non-existent file
    res = auth_client.patch("/api/files/missing-patch/ttl", json={"ttl": 3600})
    assert res.status_code == 404

    file_patch = str(uuid.uuid4())
    # Create file
    meta = FileMetadata(file_patch, "patch.txt", 3600, time.time() - 50)
    meta.save(isolate_data_dir / f"{file_patch}.meta.json")
    (isolate_data_dir / file_patch).write_bytes(b"data")

    # 400 for invalid JSON body
    res = auth_client.patch(f"/api/files/{file_patch}/ttl", content=b"not a valid json", headers={"Content-Type": "application/json"})
    assert res.status_code == 400
    assert "Invalid JSON body" in res.json()["detail"]

    # 400 for missing ttl field
    res = auth_client.patch(f"/api/files/{file_patch}/ttl", json={"not_ttl": 123})
    assert res.status_code == 400
    assert "'ttl' field is required" in res.json()["detail"]

    # 400 for invalid ttl
    res = auth_client.patch(f"/api/files/{file_patch}/ttl", json={"ttl": -10})
    assert res.status_code == 400

    res = auth_client.patch(f"/api/files/{file_patch}/ttl", json={"ttl": "invalid"})
    assert res.status_code == 400

    # 200 for valid ttl
    res = auth_client.patch(f"/api/files/{file_patch}/ttl", json={"ttl": 7200})
    assert res.status_code == 200
    data = res.json()
    assert data["id"] == file_patch
    assert data["expires_in"] > 7000


def test_mcp_server_instance():
    assert mcp.name == "TmpUp"


def test_mcp_upload_file(isolate_data_dir, capsys):
    content = b"MCP upload test content"
    b64_content = base64.b64encode(content).decode()

    # Valid upload
    res = upload_file("mcp_test.txt", b64_content, ttl=1800)
    assert "url" in res
    assert "id" in res
    assert res["expires_in"] == 1800
    file_id = res["id"]

    # Verify on disk
    saved_file = isolate_data_dir / file_id
    assert saved_file.exists()
    assert saved_file.read_bytes() == content

    captured = capsys.readouterr().out
    assert "mcp_upload_success" in captured

    # Invalid TTL
    with pytest.raises(ValueError):
        upload_file("fail.txt", b64_content, ttl=-1)

    # Empty content
    empty_b64 = base64.b64encode(b"").decode()
    with pytest.raises(ValueError):
        upload_file("empty.txt", empty_b64, ttl=0)

    # Invalid base64
    with pytest.raises(ValueError):
        upload_file("bad.txt", "not_valid_base64!!!", ttl=0)


def test_mcp_upload_file_base64_preserves_cause():
    with pytest.raises(ValueError) as exc_info:
        upload_file("bad.txt", "not_valid_base64!@#$%", ttl=0)
    assert exc_info.value.__cause__ is not None


def test_mcp_list_files(isolate_data_dir):
    assert list_files() == []

    mcp_f1 = str(uuid.uuid4())
    meta = FileMetadata(mcp_f1, "f1.txt", 0, time.time())
    meta.save(isolate_data_dir / f"{mcp_f1}.meta.json")
    (isolate_data_dir / mcp_f1).write_bytes(b"data1")

    files = list_files()
    assert len(files) == 1
    assert files[0]["id"] == mcp_f1


def test_mcp_get_file_info(isolate_data_dir):
    mcp_f2 = str(uuid.uuid4())
    meta = FileMetadata(mcp_f2, "f2.txt", 3600, time.time())
    meta.save(isolate_data_dir / f"{mcp_f2}.meta.json")
    (isolate_data_dir / mcp_f2).write_bytes(b"data2")

    info = get_file_info(mcp_f2)
    assert info["id"] == mcp_f2
    assert info["filename"] == "f2.txt"

    with pytest.raises(ValueError):
        get_file_info("missing-mcp-f2")


def test_mcp_extend_ttl(isolate_data_dir):
    mcp_f3 = str(uuid.uuid4())
    meta = FileMetadata(mcp_f3, "f3.txt", 100, time.time())
    meta.save(isolate_data_dir / f"{mcp_f3}.meta.json")
    (isolate_data_dir / mcp_f3).write_bytes(b"data3")

    info = extend_ttl(mcp_f3, 86400)
    assert info["id"] == mcp_f3
    assert info["expires_in"] > 80000

    with pytest.raises(ValueError):
        extend_ttl("missing-mcp-f3", 86400)


def test_mcp_delete_file(isolate_data_dir):
    mcp_f4 = str(uuid.uuid4())
    meta = FileMetadata(mcp_f4, "f4.txt", 3600, time.time())
    meta.save(isolate_data_dir / f"{mcp_f4}.meta.json")
    (isolate_data_dir / mcp_f4).write_bytes(b"data4")

    res = delete_file(mcp_f4)
    assert res == {"deleted": True}
    assert not (isolate_data_dir / mcp_f4).exists()

    res2 = delete_file(mcp_f4)
    assert res2 == {"deleted": False}


def test_mcp_auth_protection(monkeypatch):
    # Test without credentials -> 401
    client = TestClient(app)
    res = client.get("/mcp")
    assert res.status_code == 401
    assert res.json() == {
        "error": "unauthorized",
        "detail": "Provide session cookie or X-API-Key header",
    }

    # Test with valid X-API-Key (with startup/shutdown lifecycle)
    monkeypatch.setattr("app.API_KEYS", {"valid-mcp-key"})
    with TestClient(app, headers={"X-API-Key": "valid-mcp-key"}) as auth_client:
        res = auth_client.get("/mcp")
        assert res.status_code != 401
        assert res.status_code < 500


def test_invalid_file_id_and_path_traversal(isolate_data_dir, auth_client, tmp_path):
    # Canary file outside DATA_DIR to ensure path traversal attempts never touch external files
    outside_dir = tmp_path / "outside"
    outside_dir.mkdir()
    canary_file = outside_dir / "passwd"
    canary_content = b"root:x:0:0:root:/root:/bin/bash"
    canary_file.write_bytes(canary_content)
    canary_mtime = canary_file.stat().st_mtime_ns

    bad_ids = ["nao-e-uuid", "12345"]

    for bad_id in bad_ids:
        # 1. get_file_paths raises ValueError
        with pytest.raises(ValueError):
            get_file_paths(bad_id)

        # 2. Helpers return None or False
        assert _get_file_info(bad_id) is None
        assert extend_file_ttl(bad_id, 3600) is None
        assert delete_file_by_id(bad_id) is False

        # 3. MCP tools raise ValueError or return {"deleted": False}
        with pytest.raises(ValueError):
            get_file_info(bad_id)
        with pytest.raises(ValueError):
            extend_ttl(bad_id, 3600)
        assert delete_file(bad_id) == {"deleted": False}

        # 4. REST routes return 404
        assert auth_client.get(f"/api/files/{bad_id}").status_code == 404
        assert auth_client.delete(f"/api/files/{bad_id}").status_code == 404
        assert auth_client.patch(f"/api/files/{bad_id}/ttl", json={"ttl": 3600}).status_code == 404
        assert auth_client.get(f"/d/{bad_id}/test.txt").status_code == 404
        assert auth_client.get(f"/v/{bad_id}/test.png").status_code == 404

    # Verify canary file outside DATA_DIR was never accessed/modified/deleted
    assert canary_file.exists()
    assert canary_file.read_bytes() == canary_content
    assert canary_file.stat().st_mtime_ns == canary_mtime


def test_existing_routes_regression(auth_client, isolate_data_dir):
    # 1. Root /
    res = auth_client.get("/")
    assert res.status_code == 200
    assert "TmpUp" in res.text

    # 2. Health
    res = auth_client.get("/health")
    assert res.status_code == 200
    assert res.json() == {"status": "ok"}

    # 3. Login
    res = auth_client.get("/auth/login")
    assert res.status_code == 200
    assert "Entrar com Google" in res.text

    # 4. Logout
    res = auth_client.get("/auth/logout", follow_redirects=False)
    assert res.status_code == 302
    assert res.headers["location"] == "/auth/login"

    # 5. Google auth redirect
    res = auth_client.get("/auth/google", follow_redirects=False)
    assert res.status_code == 302
    assert "accounts.google.com" in res.headers["location"]

    # 6. POST /api/upload
    # missing filename
    res = auth_client.post("/api/upload", content=b"data")
    assert res.status_code == 400

    # invalid TTL
    res = auth_client.post("/api/upload", content=b"data", headers={"X-Filename": "test.txt", "X-TTL": "abc"})
    assert res.status_code == 400

    res = auth_client.post("/api/upload", content=b"data", headers={"X-Filename": "test.txt", "X-TTL": "-5"})
    assert res.status_code == 400

    # successful upload
    res = auth_client.post(
        "/api/upload",
        content=b"hello upload",
        headers={"X-Filename": "test.txt", "X-TTL": "3600"},
    )
    assert res.status_code == 200
    upload_data = res.json()
    assert "id" in upload_data
    file_id = upload_data["id"]
    assert upload_data["expires_in"] == 3600

    # 7. GET /api/files
    res = auth_client.get("/api/files")
    assert res.status_code == 200
    files = res.json()
    assert len(files) >= 1
    assert any(f["id"] == file_id for f in files)

    # 8. GET /d/{file_id}/{filename} (download)
    res = auth_client.get(f"/d/{file_id}/test.txt")
    assert res.status_code == 200
    assert res.content == b"hello upload"

    # 9. GET /v/{file_id}/{filename} for non-image redirects to /d/
    res = auth_client.get(f"/v/{file_id}/test.txt", follow_redirects=False)
    assert res.status_code == 307
    assert res.headers["location"] == f"/d/{file_id}/test.txt"

    # 10. Image upload and viewer
    res = auth_client.post(
        "/api/upload",
        content=b"fake-png-bytes",
        headers={"X-Filename": "photo.png", "X-TTL": "0"},
    )
    assert res.status_code == 200
    img_id = res.json()["id"]

    res = auth_client.get(f"/v/{img_id}/photo.png")
    assert res.status_code == 200
    assert "<img class=\"viewer-img\"" in res.text

    # 11. Admin set-all-infinite
    res = auth_client.post("/admin/set-all-infinite")
    assert res.status_code == 200
    assert "updated" in res.json()


def test_routes_are_async_def(monkeypatch, auth_client, isolate_data_dir):
    """Verify that the endpoints are async def and offload blocking I/O to run_in_threadpool."""
    assert asyncio.iscoroutinefunction(api_list_files)
    assert asyncio.iscoroutinefunction(get_file)
    assert asyncio.iscoroutinefunction(delete_file_endpoint)
    assert asyncio.iscoroutinefunction(patch_file_ttl)

    calls = []
    import starlette.concurrency
    orig_run_in_threadpool = starlette.concurrency.run_in_threadpool

    async def tracking_run_in_threadpool(func, *args, **kwargs):
        calls.append(func.__name__)
        return await orig_run_in_threadpool(func, *args, **kwargs)

    monkeypatch.setattr("app.run_in_threadpool", tracking_run_in_threadpool)

    # 1. GET /api/files
    auth_client.get("/api/files")
    assert "_list_active_files" in calls

    # 2. GET /api/files/{id}
    file_id = str(uuid.uuid4())
    meta = FileMetadata(file_id, "t.txt", 3600, time.time())
    meta.save(isolate_data_dir / f"{file_id}.meta.json")
    (isolate_data_dir / file_id).write_bytes(b"t")
    auth_client.get(f"/api/files/{file_id}")
    assert "_get_file_info" in calls

    # 3. PATCH /api/files/{id}/ttl
    auth_client.patch(f"/api/files/{file_id}/ttl", json={"ttl": 7200})
    assert "extend_file_ttl" in calls

    # 4. DELETE /api/files/{id}
    auth_client.delete(f"/api/files/{file_id}")
    assert "delete_file_by_id" in calls


def test_delete_file_by_id_handles_race_condition_file_not_found(isolate_data_dir, capsys, monkeypatch):
    """delete_file_by_id must not propagate FileNotFoundError if file is deleted concurrently."""
    file_id = str(uuid.uuid4())
    file_path, meta_path = get_file_paths(file_id)
    file_path.write_bytes(b"content")
    meta = FileMetadata(file_id, "test.txt", 3600, time.time())
    meta.save(meta_path)

    # Simulate concurrent deletion where unlink raises FileNotFoundError
    def mock_unlink_not_found(self):
        raise FileNotFoundError("Simulated concurrent unlink")

    monkeypatch.setattr("pathlib.Path.unlink", mock_unlink_not_found)
    assert delete_file_by_id(file_id) is False

    captured = capsys.readouterr().out
    assert "file_delete_failed" in captured
    assert "not_found" in captured


def test_delete_file_by_id_rapid_consecutive_deletes(isolate_data_dir):
    """Calling delete_file_by_id twice quickly: first succeeds, second returns False without error."""
    file_id = str(uuid.uuid4())
    file_path, meta_path = get_file_paths(file_id)
    file_path.write_bytes(b"content")
    meta = FileMetadata(file_id, "test.txt", 3600, time.time())
    meta.save(meta_path)

    assert delete_file_by_id(file_id) is True
    assert delete_file_by_id(file_id) is False


def test_delete_file_by_id_propagates_non_file_not_found(isolate_data_dir, monkeypatch):
    """delete_file_by_id must continue propagating unexpected exceptions like PermissionError."""
    file_id = str(uuid.uuid4())
    file_path, meta_path = get_file_paths(file_id)
    file_path.write_bytes(b"content")
    meta = FileMetadata(file_id, "test.txt", 3600, time.time())
    meta.save(meta_path)

    def mock_unlink_perm(self):
        raise PermissionError("Simulated permission denied")

    monkeypatch.setattr("pathlib.Path.unlink", mock_unlink_perm)
    with pytest.raises(PermissionError, match="Simulated permission denied"):
        delete_file_by_id(file_id)


def test_direct_malicious_file_id_validation(isolate_data_dir, tmp_path):
    """Direct tests (without HTTP) calling get_file_paths, _get_file_info, delete_file_by_id, and extend_file_ttl
    with malicious file_id to verify UUID validation blocks traversal attempts."""
    outside_dir = tmp_path / "outside_direct"
    outside_dir.mkdir()
    canary = outside_dir / "secret.txt"
    canary_bytes = b"top-secret-canary"
    canary.write_bytes(canary_bytes)
    canary_mtime = canary.stat().st_mtime_ns

    malicious_ids = [
        "../../etc/cron.d/x",
        "/etc/passwd",
        "nao-e-uuid",
        f"../outside_direct/{canary.name}",
        "../../../etc/shadow",
        "invalid-uuid-12345",
        "../../DATA_DIR",
    ]

    for bad_id in malicious_ids:
        # get_file_paths must raise ValueError
        with pytest.raises(ValueError, match="Invalid file ID"):
            get_file_paths(bad_id)

        # _get_file_info must return None
        assert _get_file_info(bad_id) is None

        # delete_file_by_id must return False
        assert delete_file_by_id(bad_id) is False

        # extend_file_ttl must return None
        assert extend_file_ttl(bad_id, 3600) is None

    # Canary must remain intact
    assert canary.exists()
    assert canary.read_bytes() == canary_bytes
    assert canary.stat().st_mtime_ns == canary_mtime


def test_file_meta_dict_helper():
    """Verify extracted _file_meta_dict helper produces expected metadata dictionary."""
    now = time.time()
    meta = FileMetadata("test-id", "doc.pdf", 7200, now)
    meta_dict = _file_meta_dict(meta)
    assert meta_dict == {
        "id": "test-id",
        "filename": "doc.pdf",
        "url": f"{BASE_URL}/d/test-id/doc.pdf",
        "view_url": f"{BASE_URL}/v/test-id/doc.pdf",
        "is_image": False,
        "expires_in": meta.expires_in,
        "created_at": now,
        "size_bytes": 0,
        "views": 0,
        "downloads": 0,
        "last_viewed_at": None,
        "last_downloaded_at": None,
    }


def test_file_meta_dict_real_file_size_and_metrics(isolate_data_dir):
    """_file_meta_dict returns correct size_bytes from disk and metrics fields, with 0 on FileNotFoundError."""
    file_id = str(uuid.uuid4())
    content = b"x" * 1234
    (isolate_data_dir / file_id).write_bytes(content)
    now = time.time()
    meta = FileMetadata(
        file_id=file_id,
        filename="report.pdf",
        ttl=3600,
        created_at=now,
        views=4,
        downloads=2,
        last_viewed_at=now - 50,
        last_downloaded_at=now - 10,
    )
    meta_dict = _file_meta_dict(meta)
    assert meta_dict["size_bytes"] == 1234
    assert meta_dict["views"] == 4
    assert meta_dict["downloads"] == 2
    assert meta_dict["last_viewed_at"] == now - 50
    assert meta_dict["last_downloaded_at"] == now - 10

    # If file is missing on disk, size_bytes must be 0 without raising FileNotFoundError
    (isolate_data_dir / file_id).unlink()
    missing_dict = _file_meta_dict(meta)
    assert missing_dict["size_bytes"] == 0



def test_validate_ttl_boundary_and_simplified_check():
    """Verify simplified validate_ttl: 0 is allowed, negative rejected, > 1 year rejected."""
    assert validate_ttl(0) == 0
    assert validate_ttl(86400 * 365) == 86400 * 365
    with pytest.raises(ValueError, match="TTL must be 0 .* or between 1 and 31536000"):
        validate_ttl(-1)
    with pytest.raises(ValueError, match="TTL must be 0 .* or between 1 and 31536000"):
        validate_ttl(86400 * 365 + 1)


def test_extend_file_ttl_and_mcp_upload_catch_only_value_error(monkeypatch):
    """Verify that extend_file_ttl and upload_file catch ValueError specifically, not generic Exception."""
    def broken_validate_ttl(ttl):
        raise TypeError("Simulated unexpected TypeError in validation")

    monkeypatch.setattr("app.validate_ttl", broken_validate_ttl)

    # In extend_file_ttl: TypeError should NOT be caught by 'except ValueError' and should propagate directly
    with pytest.raises(TypeError, match="Simulated unexpected TypeError"):
        extend_file_ttl("some-id", 3600)

    # In upload_file: TypeError should NOT be caught by 'except ValueError' and should propagate directly
    with pytest.raises(TypeError, match="Simulated unexpected TypeError"):
        upload_file("test.txt", "aGVsbG8=", ttl=3600)


def test_mcp_upload_file_rejects_payload_exceeding_size_limit(isolate_data_dir, monkeypatch):
    """upload_file must reject content_base64 exceeding size limit with ValueError before decoding."""
    monkeypatch.setattr("app.MAX_MCP_UPLOAD_SIZE", 30)
    small_data = b"x" * 31
    small_b64 = base64.b64encode(small_data).decode()
    with pytest.raises(ValueError, match="File exceeds maximum allowed size"):
        upload_file("small_limit.bin", small_b64, ttl=0)

    # Verify that invalid base64 in oversized payload still raises the size error (proves it checks BEFORE decoding)
    oversized_invalid_b64 = "?" * len(small_b64)
    with pytest.raises(ValueError, match="File exceeds maximum allowed size"):
        upload_file("small_invalid.bin", oversized_invalid_b64, ttl=0)

    # Within limit works
    allowed_data = b"x" * 30
    allowed_b64 = base64.b64encode(allowed_data).decode()
    res = upload_file("allowed.bin", allowed_b64, ttl=0)
    assert "id" in res


def test_file_metadata_defaults_and_backwards_compatibility():
    """FileMetadata initializes new fields with defaults, to_dict includes them, and from_dict supports legacy dicts without them."""
    now = 1000.0
    meta = FileMetadata("id1", "file.txt", 3600, now)
    assert meta.views == 0
    assert meta.downloads == 0
    assert meta.last_viewed_at is None
    assert meta.last_downloaded_at is None
    assert meta.size_bytes == 0
    assert meta.to_dict() == {
        "file_id": "id1",
        "filename": "file.txt",
        "ttl": 3600,
        "created_at": now,
        "views": 0,
        "downloads": 0,
        "last_viewed_at": None,
        "last_downloaded_at": None,
        "size_bytes": 0,
    }

    legacy_data = {
        "file_id": "old-id",
        "filename": "old.txt",
        "ttl": 1800,
        "created_at": 500.0,
    }
    meta_legacy = FileMetadata.from_dict(legacy_data)
    assert meta_legacy.file_id == "old-id"
    assert meta_legacy.filename == "old.txt"
    assert meta_legacy.ttl == 1800
    assert meta_legacy.created_at == 500.0
    assert meta_legacy.views == 0
    assert meta_legacy.downloads == 0
    assert meta_legacy.last_viewed_at is None
    assert meta_legacy.last_downloaded_at is None
    assert meta_legacy.size_bytes == 0

    full_data = {
        "file_id": "id2",
        "filename": "new.txt",
        "ttl": 1800,
        "created_at": 500.0,
        "views": 5,
        "downloads": 3,
        "last_viewed_at": 600.0,
        "last_downloaded_at": 700.0,
        "size_bytes": 2048,
    }
    meta_full = FileMetadata.from_dict(full_data)
    assert meta_full.views == 5
    assert meta_full.downloads == 3
    assert meta_full.last_viewed_at == 600.0
    assert meta_full.last_downloaded_at == 700.0
    assert meta_full.size_bytes == 2048
    assert meta_full.to_dict() == full_data


def test_rest_endpoints_return_new_metadata_fields(auth_client, isolate_data_dir):
    """GET /api/files and GET /api/files/{id} return all new metadata fields alongside existing fields."""
    file_id = str(uuid.uuid4())
    content = b"sample content for testing"
    (isolate_data_dir / file_id).write_bytes(content)
    now = time.time()
    meta = FileMetadata(
        file_id=file_id,
        filename="notes.txt",
        ttl=3600,
        created_at=now,
        views=3,
        downloads=7,
        last_viewed_at=now - 40,
        last_downloaded_at=now - 20,
    )
    meta.save(isolate_data_dir / f"{file_id}.meta.json")

    # 1. GET /api/files/{id}
    res = auth_client.get(f"/api/files/{file_id}")
    assert res.status_code == 200
    data = res.json()
    expected_fields = {
        "id", "filename", "url", "view_url", "is_image", "expires_in", "created_at",
        "size_bytes", "views", "downloads", "last_viewed_at", "last_downloaded_at"
    }
    assert expected_fields.issubset(data.keys())
    assert data["id"] == file_id
    assert data["filename"] == "notes.txt"
    assert data["size_bytes"] == len(content)
    assert data["views"] == 3
    assert data["downloads"] == 7
    assert data["last_viewed_at"] == now - 40
    assert data["last_downloaded_at"] == now - 20

    # 2. GET /api/files
    res_list = auth_client.get("/api/files")
    assert res_list.status_code == 200
    files = res_list.json()
    item = next(f for f in files if f["id"] == file_id)
    assert expected_fields.issubset(item.keys())
    assert item["size_bytes"] == len(content)
    assert item["views"] == 3
    assert item["downloads"] == 7
    assert item["last_viewed_at"] == now - 40
    assert item["last_downloaded_at"] == now - 20


def test_download_file_tracks_views_and_downloads(auth_client, isolate_data_dir):
    """GET /d/... with inline Content-Disposition increments views and sets last_viewed_at; with attachment increments downloads and sets last_downloaded_at."""
    # 1. Inline file (image/png)
    img_id = str(uuid.uuid4())
    img_meta = FileMetadata(img_id, "test.png", 3600, time.time())
    img_meta_path = isolate_data_dir / f"{img_id}.meta.json"
    img_meta.save(img_meta_path)
    (isolate_data_dir / img_id).write_bytes(b"\x89PNG\r\n\x1a\nfake-png")

    t_before_view = time.time()
    res1 = auth_client.get(f"/d/{img_id}/test.png")
    assert res1.status_code == 200
    assert res1.headers.get("content-disposition") == "inline"

    reloaded_img = FileMetadata.from_file(img_meta_path)
    assert reloaded_img.views == 1
    assert reloaded_img.downloads == 0
    assert reloaded_img.last_viewed_at is not None
    assert reloaded_img.last_viewed_at >= t_before_view
    assert reloaded_img.last_downloaded_at is None

    # Call again to verify idempotent counting (each call increments once)
    res2 = auth_client.get(f"/d/{img_id}/test.png")
    assert res2.status_code == 200
    reloaded_img2 = FileMetadata.from_file(img_meta_path)
    assert reloaded_img2.views == 2
    assert reloaded_img2.downloads == 0

    # 2. Attachment file (application/octet-stream or application/zip)
    bin_id = str(uuid.uuid4())
    bin_meta = FileMetadata(bin_id, "archive.zip", 3600, time.time())
    bin_meta_path = isolate_data_dir / f"{bin_id}.meta.json"
    bin_meta.save(bin_meta_path)
    (isolate_data_dir / bin_id).write_bytes(b"PK\x03\x04fake-zip")

    t_before_dl = time.time()
    res_dl1 = auth_client.get(f"/d/{bin_id}/archive.zip")
    assert res_dl1.status_code == 200
    assert res_dl1.headers.get("content-disposition", "").startswith("attachment")

    reloaded_bin = FileMetadata.from_file(bin_meta_path)
    assert reloaded_bin.downloads == 1
    assert reloaded_bin.views == 0
    assert reloaded_bin.last_downloaded_at is not None
    assert reloaded_bin.last_downloaded_at >= t_before_dl
    assert reloaded_bin.last_viewed_at is None

    # Call again: increments downloads to 2
    res_dl2 = auth_client.get(f"/d/{bin_id}/archive.zip")
    assert res_dl2.status_code == 200
    reloaded_bin2 = FileMetadata.from_file(bin_meta_path)
    assert reloaded_bin2.downloads == 2
    assert reloaded_bin2.views == 0


def test_viewer_page_redesign(auth_client, isolate_data_dir):
    """Viewer page includes new elements (viewerMetrics, deleteBtn, deletedCard) and correctly serialized JS fileId and imageUrlAbs."""
    img_id = str(uuid.uuid4())
    img_meta = FileMetadata(img_id, "test_pic.png", 3600, time.time())
    img_meta.save(isolate_data_dir / f"{img_id}.meta.json")
    (isolate_data_dir / img_id).write_bytes(b"\x89PNG\r\n\x1a\ncontent")

    res = auth_client.get(f"/v/{img_id}/test_pic.png")
    assert res.status_code == 200
    html = res.text
    assert '<div class="viewer-metrics" id="viewerMetrics"></div>' in html
    assert 'id="deleteBtn"' in html
    assert 'id="deletedCard"' in html
    assert f'const fileId = "{img_id}";' in html
    assert f'const imageUrlAbs = "{BASE_URL}/d/{img_id}/test_pic.png";' in html


def test_main_page_redesign(auth_client):
    """Main page HTML contains redesigned components: summary bar, search input, filter chips, sort select, bulk action bar, inline renewal, and paste handler."""
    res = auth_client.get("/")
    assert res.status_code == 200
    html = res.text
    assert 'id="summaryBar"' in html
    assert 'id="searchInput"' in html
    assert 'id="chipRow"' in html
    assert 'id="sortSelect"' in html
    assert 'id="bulkBar"' in html
    assert 'id="bulkRenewBtn"' in html
    assert 'id="bulkDeleteBtn"' in html
    assert 'id="bulkCancelBtn"' in html
    assert 'data-action="renew-toggle"' in html
    assert 'data-action="renew-apply"' in html
    assert 'data-action="delete"' in html
    assert 'data-action="select"' in html
    assert "print-colado" in html


def test_security_xss_and_metadata_filename_in_viewer_and_download(auth_client, isolate_data_dir):
    """Confirm XSS prevention in viewer (HTML escape and JSON </ escaping) and that real metadata.filename is used instead of URL segment."""
    img_id = str(uuid.uuid4())
    malicious_filename = "evil</script><script>alert(1)</script>.png"
    meta = FileMetadata(img_id, malicious_filename, 3600, time.time())
    meta_path = isolate_data_dir / f"{img_id}.meta.json"
    meta.save(meta_path)
    (isolate_data_dir / img_id).write_bytes(b"\x89PNG\r\n\x1a\nfake-png")

    # 1. Access with a completely different URL path
    res = auth_client.get(f"/v/{img_id}/qualquer-coisa.png")
    assert res.status_code == 200
    html = res.text

    # Must display the real metadata.filename, NOT 'qualquer-coisa.png'
    assert "qualquer-coisa.png" not in html
    # Must have escaped HTML filename, not raw unescaped tags
    assert "&lt;script&gt;alert(1)&lt;/script&gt;.png" in html
    assert "<script>alert(1)</script>" not in html

    # Inside <script> blocks, there must be NO raw '</script>'
    # Extract the script content or check for raw '</script>' before the real closing tag
    assert "</script><script>" not in html
    assert r"<\/" in html or r"\/" in html

    # 2. Reflected XSS attempt via URL path on valid file
    valid_id = str(uuid.uuid4())
    valid_meta = FileMetadata(valid_id, "safe_image.png", 3600, time.time())
    valid_meta.save(isolate_data_dir / f"{valid_id}.meta.json")
    (isolate_data_dir / valid_id).write_bytes(b"\x89PNG\r\n\x1a\nfake-png")

    attack_url_name = "x%3Cimg%20src%3Dx%20onerror%3Dalert(1)%3E.png"
    res_xss = auth_client.get(f"/v/{valid_id}/{attack_url_name}")
    assert res_xss.status_code == 200
    assert "safe_image.png" in res_xss.text
    assert "onerror=alert(1)" not in res_xss.text
    assert "<img src=x" not in res_xss.text

    # 3. Content-Disposition in /d/ must use metadata.filename, not URL segment
    res_d = auth_client.get(f"/d/{valid_id}/injected_name.bin?dl=1")
    assert res_d.status_code == 200
    cd = res_d.headers.get("content-disposition", "")
    assert "safe_image.png" in cd
    assert "injected_name.bin" not in cd


def test_download_dl_param_forces_attachment_and_increments_downloads(auth_client, isolate_data_dir):
    """GET /d/... with ?dl=1 forces attachment and increments downloads even for inline types."""
    img_id = str(uuid.uuid4())
    meta = FileMetadata(img_id, "photo.png", 3600, time.time())
    meta_path = isolate_data_dir / f"{img_id}.meta.json"
    meta.save(meta_path)
    (isolate_data_dir / img_id).write_bytes(b"\x89PNG\r\n\x1a\nfake-png")

    # 1. Normal GET without dl: inline, views=1, downloads=0
    res_view = auth_client.get(f"/d/{img_id}/photo.png")
    assert res_view.status_code == 200
    assert res_view.headers.get("content-disposition") == "inline"
    reloaded = FileMetadata.from_file(meta_path)
    assert reloaded.views == 1
    assert reloaded.downloads == 0

    # 2. GET with ?dl=1: attachment, views=1, downloads=1
    res_dl = auth_client.get(f"/d/{img_id}/photo.png?dl=1")
    assert res_dl.status_code == 200
    assert res_dl.headers.get("content-disposition", "").startswith("attachment")
    assert "photo.png" in res_dl.headers.get("content-disposition", "")
    reloaded = FileMetadata.from_file(meta_path)
    assert reloaded.views == 1
    assert reloaded.downloads == 1


def test_upload_and_viewer_security_xss_e2e(auth_client, isolate_data_dir):
    """AC 1 & 2: Upload file with X-Filename evil<script>alert(1)</script>.png and confirm GET /v/{id}/{qualquer-coisa.png} returns real metadata.filename escaped, no raw tags, no unescaped </script> in script blocks, and Content-Disposition in /d/ uses metadata.filename."""
    from urllib.parse import quote
    malicious_filename = "evil</script><script>alert(1)</script>.png"
    encoded_name = quote(malicious_filename)
    payload = b"\x89PNG\r\n\x1a\nmalicious-test-content"

    upload_res = auth_client.post(
        "/api/upload",
        headers={"X-Filename": encoded_name, "X-TTL": "3600"},
        content=payload,
    )
    assert upload_res.status_code == 200
    file_id = upload_res.json()["id"]

    # Verify size_bytes persisted
    meta_path = isolate_data_dir / f"{file_id}.meta.json"
    saved_meta = FileMetadata.from_file(meta_path)
    assert saved_meta.size_bytes == len(payload)

    # 1. GET /v/{file_id}/qualquer-coisa.png
    viewer_res = auth_client.get(f"/v/{file_id}/qualquer-coisa.png")
    assert viewer_res.status_code == 200
    html = viewer_res.text

    # Path from URL must be ignored for display
    assert "qualquer-coisa.png" not in html
    # Real name must be escaped in HTML context
    assert "evil&lt;/script&gt;&lt;script&gt;alert(1)&lt;/script&gt;.png" in html
    assert "<script>alert(1)</script>" not in html

    # Inside <script> block, </script> must be escaped as <\/script>
    script_blocks = re.findall(r"<script>(.*?)</script>", html, flags=re.DOTALL)
    assert len(script_blocks) == 1
    script_content = script_blocks[0]
    assert "</script>" not in script_content
    assert r"<\/" in script_content

    # 2. Content-Disposition in /d/ must use metadata.filename
    d_res = auth_client.get(f"/d/{file_id}/arbitrary_name.png?dl=1")
    assert d_res.status_code == 200
    cd = d_res.headers.get("content-disposition", "")
    assert "evil" in cd
    assert "arbitrary_name.png" not in cd


def test_metadata_size_bytes_persistence_and_stat_fallback(auth_client, isolate_data_dir):
    """AC 5: size_bytes is persisted on upload and MCP upload_file; _file_meta_dict uses metadata.size_bytes when > 0 and falls back to stat() when 0/missing."""
    # 1. Upload via stream persists size_bytes
    payload = b"hello world 12345"
    up_res = auth_client.post(
        "/api/upload",
        headers={"X-Filename": "stream_file.txt", "X-TTL": "3600"},
        content=payload,
    )
    assert up_res.status_code == 200
    fid = up_res.json()["id"]

    meta_stream = FileMetadata.from_file(isolate_data_dir / f"{fid}.meta.json")
    assert meta_stream.size_bytes == len(payload)

    # 2. MCP upload_file persists size_bytes
    mcp_res = upload_file("mcp_test.txt", base64.b64encode(b"mcp content bytes").decode(), ttl=3600)
    mcp_fid = mcp_res["id"]
    meta_mcp = FileMetadata.from_file(isolate_data_dir / f"{mcp_fid}.meta.json")
    assert meta_mcp.size_bytes == len(b"mcp content bytes")

    # 3. _file_meta_dict uses metadata.size_bytes when > 0 without needing stat()
    fake_id = str(uuid.uuid4())
    fake_meta = FileMetadata(fake_id, "fake.txt", 3600, time.time(), size_bytes=999999)
    # Note: no file written to disk for fake_id!
    info = _file_meta_dict(fake_meta)
    assert info["size_bytes"] == 999999

    # 4. _file_meta_dict falls back to stat() when size_bytes is 0 (legacy metadata)
    legacy_id = str(uuid.uuid4())
    (isolate_data_dir / legacy_id).write_bytes(b"legacy bytes on disk")
    legacy_meta = FileMetadata(legacy_id, "legacy.txt", 3600, time.time(), size_bytes=0)
    info_legacy = _file_meta_dict(legacy_meta)
    assert info_legacy["size_bytes"] == len(b"legacy bytes on disk")


def test_frontend_review_fixes_elements_and_handlers(auth_client, isolate_data_dir):
    """AC 3, 4, 6, 7, 8: Viewer error element, dl=1 on viewer download, for='ttlSelect', loadFiles validation, bulk action failure handling."""
    # Main page checks
    main_res = auth_client.get("/")
    assert main_res.status_code == 200
    main_html = main_res.text

    # AC 7: <label for='ttlSelect'>
    assert '<label for="ttlSelect">' in main_html

    # AC 8: loadFiles checks res.ok and Array.isArray
    assert "if(!res.ok)" in main_html or "if (!res.ok)" in main_html
    assert "Array.isArray(data)" in main_html

    # AC 4: bulk actions check response.ok and count actual successes/failures
    assert "successCount" in main_html
    assert "${successCount} de ${ids.length} arquivo(s) excluidos" in main_html
    assert "${successCount} de ${ids.length} arquivo(s) renovados" in main_html

    # Viewer page checks
    img_id = str(uuid.uuid4())
    img_meta = FileMetadata(img_id, "view_test.png", 3600, time.time())
    img_meta.save(isolate_data_dir / f"{img_id}.meta.json")
    (isolate_data_dir / img_id).write_bytes(b"\x89PNG\r\n\x1a\ncontent")

    viewer_res = auth_client.get(f"/v/{img_id}/view_test.png")
    assert viewer_res.status_code == 200
    viewer_html = viewer_res.text

    # AC 3: Viewer download button has ?dl=1
    assert f'href="/d/{img_id}/view_test.png?dl=1"' in viewer_html
    assert 'download="view_test.png"' in viewer_html

    # AC 6: Viewer has error element and error feedback on delete failure
    assert 'id="viewerError"' in viewer_html
    assert "Erro ao excluir arquivo" in viewer_html







