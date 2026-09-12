import asyncio
import base64
import inspect
import json
import re
import time
import uuid
from pathlib import Path

import pytest
from PIL import Image
from fastapi import HTTPException
from fastapi.testclient import TestClient

import app as app_module
from app import (
    BASE_URL,
    FileMetadata,
    HTML_TEMPLATE,
    _download_file,
    _file_meta_dict,
    _filter_sort_paginate_files,
    _get_file_info,
    _list_active_files,
    _thumbnail_file,
    _view_file,
    _delete_thumbnail,
    api_list_files,
    app,
    delete_file,
    delete_file_by_id,
    delete_file_endpoint,
    download_file,
    extend_file_ttl,
    extend_ttl,
    generate_thumbnail,
    get_file,
    get_file_info,
    get_file_paths,
    list_files,
    log_event,
    mcp,
    patch_file_ttl,
    upload_file,
    validate_ttl,
    view_file,
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
    initial = list_files()
    assert initial == {
        "items": [],
        "total": 0,
        "page": 1,
        "page_size": 50,
        "total_pages": 0,
        "total_size_bytes": 0,
        "expiring_soon_count": 0,
    }

    mcp_f1 = str(uuid.uuid4())
    meta = FileMetadata(mcp_f1, "f1.txt", 0, time.time())
    meta.save(isolate_data_dir / f"{mcp_f1}.meta.json")
    (isolate_data_dir / mcp_f1).write_bytes(b"data1")

    files = list_files()
    assert isinstance(files, dict)
    assert files["total"] == 1
    assert files["page"] == 1
    assert files["page_size"] == 50
    assert files["total_pages"] == 1
    assert len(files["items"]) == 1
    assert files["items"][0]["id"] == mcp_f1


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
    files = res.json()["items"]
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
    assert asyncio.iscoroutinefunction(download_file)
    assert asyncio.iscoroutinefunction(view_file)

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

    # 5. GET /d/{id}/{filename}
    dl_id = str(uuid.uuid4())
    dl_meta = FileMetadata(dl_id, "dl.txt", 3600, time.time())
    dl_meta.save(isolate_data_dir / f"{dl_id}.meta.json")
    (isolate_data_dir / dl_id).write_bytes(b"hello")
    auth_client.get(f"/d/{dl_id}/dl.txt")
    assert "_download_file" in calls

    # 6. GET /v/{id}/{filename}
    auth_client.get(f"/v/{dl_id}/dl.txt")
    assert "_view_file" in calls


def test_download_and_view_file_helpers_are_sync(isolate_data_dir):
    """Confirm that the extracted helpers for download_file and view_file are synchronous functions (not coroutines)
    and can be called directly/synchronously to perform blocking disk I/O."""
    assert not asyncio.iscoroutinefunction(_download_file)
    assert not asyncio.iscoroutinefunction(_view_file)

    # Test _download_file sync execution directly
    file_id = str(uuid.uuid4())
    meta = FileMetadata(file_id, "test.png", 3600, time.time())
    meta.save(isolate_data_dir / f"{file_id}.meta.json")
    (isolate_data_dir / file_id).write_bytes(b"fakepng")

    # Call _download_file directly (synchronously)
    resp = _download_file(file_id, "test.png")
    assert not asyncio.iscoroutine(resp)
    assert resp.status_code == 200
    assert resp.media_type == "image/png"
    assert resp.headers["content-disposition"] == "inline"

    # Reload meta to verify views incremented synchronously
    reloaded = FileMetadata.from_file(isolate_data_dir / f"{file_id}.meta.json")
    assert reloaded.views == 1

    # Call _download_file with dl=1
    resp_dl = _download_file(file_id, "test.png", dl="1")
    assert resp_dl.status_code == 200
    assert "attachment" in resp_dl.headers["content-disposition"]

    # Reload meta to verify downloads incremented synchronously
    reloaded = FileMetadata.from_file(isolate_data_dir / f"{file_id}.meta.json")
    assert reloaded.downloads == 1

    # Test _view_file sync execution directly for image
    view_resp = _view_file(file_id, "test.png")
    assert not asyncio.iscoroutine(view_resp)
    assert view_resp.status_code == 200
    assert "test.png" in view_resp.body.decode("utf-8")

    # Test _view_file sync execution directly for non-image (redirects)
    txt_id = str(uuid.uuid4())
    txt_meta = FileMetadata(txt_id, "doc.txt", 3600, time.time())
    txt_meta.save(isolate_data_dir / f"{txt_id}.meta.json")
    (isolate_data_dir / txt_id).write_bytes(b"text")

    view_txt_resp = _view_file(txt_id, "doc.txt")
    assert not asyncio.iscoroutine(view_txt_resp)
    assert view_txt_resp.status_code == 307
    assert view_txt_resp.headers["location"] == f"/d/{txt_id}/doc.txt"

    # Verify 404 behavior raises HTTPException synchronously
    with pytest.raises(HTTPException) as exc_info:
        _download_file("invalid-id", "test.png")
    assert exc_info.value.status_code == 404

    with pytest.raises(HTTPException) as exc_info:
        _view_file("invalid-id", "test.png")
    assert exc_info.value.status_code == 404


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

        # _download_file must raise HTTPException 404
        with pytest.raises(HTTPException) as exc:
            _download_file(bad_id, "test.png")
        assert exc.value.status_code == 404

        # _view_file must raise HTTPException 404
        with pytest.raises(HTTPException) as exc:
            _view_file(bad_id, "test.png")
        assert exc.value.status_code == 404

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
    files = res_list.json()["items"]
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

    # AC 8: loadFiles checks res.ok and Array.isArray(data.items)
    assert "if(!res.ok)" in main_html or "if (!res.ok)" in main_html
    assert "Array.isArray(data.items)" in main_html

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


def test_generate_thumbnail_large_image(tmp_path):
    """AC 2: generate_thumbnail produces a much smaller JPEG file and max dimension <= 200px."""
    src = tmp_path / "large_image.png"
    thumb = tmp_path / "large_image.thumb.jpg"

    # Create a 1000x1000 RGB test image
    img = Image.new("RGB", (1000, 1000), color=(120, 180, 240))
    img.save(src, format="PNG")

    original_size = src.stat().st_size
    assert original_size > 0

    success = generate_thumbnail(src, thumb, max_size=200)
    assert success is True
    assert thumb.exists()

    thumb_size = thumb.stat().st_size
    assert thumb_size < original_size / 2

    with Image.open(thumb) as thumb_img:
        assert thumb_img.format == "JPEG"
        assert max(thumb_img.size) <= 200
        assert thumb_img.size == (200, 200)


def test_generate_thumbnail_rgba_transparency(tmp_path):
    """AC 2: generate_thumbnail handles RGBA transparency by compositing on white background."""
    src = tmp_path / "transparent.png"
    thumb = tmp_path / "transparent.thumb.jpg"

    # 400x200 RGBA image with transparency
    img = Image.new("RGBA", (400, 200), color=(255, 0, 0, 128))
    img.save(src, format="PNG")

    success = generate_thumbnail(src, thumb, max_size=200)
    assert success is True
    assert thumb.exists()

    with Image.open(thumb) as thumb_img:
        assert thumb_img.format == "JPEG"
        assert max(thumb_img.size) <= 200
        # Aspect ratio 2:1 preserved (200x100)
        assert thumb_img.size == (200, 100)
        assert thumb_img.mode == "RGB"


def test_generate_thumbnail_corrupt_file_returns_false(tmp_path):
    """AC 2: generate_thumbnail with non-image data returns False without raising an exception."""
    corrupt_file = tmp_path / "fake_image.png"
    corrupt_file.write_bytes(b"not a valid png file at all \x00\xff\xee\xdd")
    thumb = tmp_path / "fake.thumb.jpg"

    success = generate_thumbnail(corrupt_file, thumb)
    assert success is False
    assert not thumb.exists()


def test_thumbnail_file_helper_is_sync():
    """AC 3: _thumbnail_file is synchronous (not coroutine) and called via run_in_threadpool."""
    assert not inspect.iscoroutinefunction(_thumbnail_file)
    assert callable(_thumbnail_file)


def test_get_thumbnail_success_and_cached(isolate_data_dir):
    """AC 2: GET /t/{file_id}/{filename} returns 200 image/jpeg with cache headers, and reuses cached file on second call."""
    file_id = str(uuid.uuid4())
    filename = "photo.png"
    file_path = isolate_data_dir / file_id
    meta_path = isolate_data_dir / f"{file_id}.meta.json"

    # Create test image
    img = Image.new("RGB", (600, 400), color=(100, 150, 200))
    img.save(file_path, format="PNG")

    meta = FileMetadata(
        file_id=file_id,
        filename=filename,
        ttl=3600,
        created_at=time.time(),
        size_bytes=file_path.stat().st_size,
    )
    meta.save(meta_path)

    client = TestClient(app)

    # First request: generates thumbnail
    res1 = client.get(f"/t/{file_id}/{filename}")
    assert res1.status_code == 200
    assert res1.headers["content-type"] == "image/jpeg"
    assert "public" in res1.headers.get("cache-control", "")
    assert "max-age=31536000" in res1.headers.get("cache-control", "")
    assert "immutable" in res1.headers.get("cache-control", "")

    thumb_path = isolate_data_dir / f"{file_id}.thumb.jpg"
    assert thumb_path.exists()
    mtime_before = thumb_path.stat().st_mtime_ns

    # Small delay to ensure mtime would differ if file were rewritten
    time.sleep(0.01)

    # Second request: reuses cached thumbnail without regenerating
    res2 = client.get(f"/t/{file_id}/{filename}")
    assert res2.status_code == 200
    assert res2.headers["content-type"] == "image/jpeg"
    mtime_after = thumb_path.stat().st_mtime_ns
    assert mtime_before == mtime_after


def test_get_thumbnail_does_not_increment_views_or_downloads(isolate_data_dir):
    """AC 2: GET /t/... does not increment metadata.views or metadata.downloads."""
    file_id = str(uuid.uuid4())
    filename = "picture.jpg"
    file_path = isolate_data_dir / file_id
    meta_path = isolate_data_dir / f"{file_id}.meta.json"

    img = Image.new("RGB", (300, 300), color=(50, 100, 150))
    img.save(file_path, format="JPEG")

    meta = FileMetadata(
        file_id=file_id,
        filename=filename,
        ttl=3600,
        created_at=time.time(),
        views=0,
        downloads=0,
    )
    meta.save(meta_path)

    client = TestClient(app)
    res = client.get(f"/t/{file_id}/{filename}")
    assert res.status_code == 200

    saved_meta = FileMetadata.from_file(meta_path)
    assert saved_meta.views == 0
    assert saved_meta.downloads == 0


def test_get_thumbnail_non_image_returns_404(isolate_data_dir):
    """AC 2: GET /t/... for a file that is not an image returns 404."""
    file_id = str(uuid.uuid4())
    filename = "document.pdf"
    file_path = isolate_data_dir / file_id
    meta_path = isolate_data_dir / f"{file_id}.meta.json"

    file_path.write_bytes(b"%PDF-1.4 test content")
    meta = FileMetadata(file_id=file_id, filename=filename, ttl=3600, created_at=time.time())
    meta.save(meta_path)

    client = TestClient(app)
    res = client.get(f"/t/{file_id}/{filename}")
    assert res.status_code == 404


def test_get_thumbnail_invalid_id_or_path_traversal(isolate_data_dir):
    """AC 2: GET /t/... with invalid file_id or path traversal returns 404 and does not escape DATA_DIR."""
    # Direct sync helper check for invalid id and path traversal
    with pytest.raises(HTTPException) as exc:
        _thumbnail_file("not-a-uuid", "photo.png")
    assert exc.value.status_code == 404

    with pytest.raises(HTTPException) as exc:
        _thumbnail_file("../../etc/passwd", "photo.png")
    assert exc.value.status_code == 404

    client = TestClient(app)
    # Non-existent UUID returns 404
    res = client.get(f"/t/{uuid.uuid4()}/image.png")
    assert res.status_code == 404

    # Invalid ID via client returns 404
    res_bad = client.get("/t/invalid-id/image.png")
    assert res_bad.status_code == 404


def test_get_thumbnail_expired_returns_404(isolate_data_dir):
    """AC 2: GET /t/... for an expired file returns 404."""
    file_id = str(uuid.uuid4())
    filename = "expired.png"
    file_path = isolate_data_dir / file_id
    meta_path = isolate_data_dir / f"{file_id}.meta.json"

    img = Image.new("RGB", (100, 100), color=(10, 20, 30))
    img.save(file_path, format="PNG")

    meta = FileMetadata(
        file_id=file_id,
        filename=filename,
        ttl=60,
        created_at=time.time() - 120,  # expired 60s ago
    )
    meta.save(meta_path)

    client = TestClient(app)
    res = client.get(f"/t/{file_id}/{filename}")
    assert res.status_code == 404


def test_get_thumbnail_fallback_when_generation_fails(isolate_data_dir):
    """AC 2: When generate_thumbnail fails, serve the original file as fallback without breaking."""
    file_id = str(uuid.uuid4())
    filename = "corrupted.png"
    file_path = isolate_data_dir / file_id
    meta_path = isolate_data_dir / f"{file_id}.meta.json"

    original_bytes = b"corrupted image bytes that PIL cannot decode"
    file_path.write_bytes(original_bytes)

    meta = FileMetadata(
        file_id=file_id,
        filename=filename,
        ttl=3600,
        created_at=time.time(),
    )
    meta.save(meta_path)

    client = TestClient(app)
    res = client.get(f"/t/{file_id}/{filename}")
    assert res.status_code == 200
    assert res.content == original_bytes


def test_frontend_file_thumb_src_uses_route_t():
    """AC 4: In HTML_TEMPLATE, img.file-thumb src replaces /d/ with /t/."""
    # Matches f.url.replace('/d/', '/t/') or similar
    assert 'replace("/d/", "/t/")' in HTML_TEMPLATE or "replace('/d/', '/t/')" in HTML_TEMPLATE
    # Ensure original f.url is NOT used directly as thumb src
    assert '<img class="file-thumb" src="${esc(f.url)}"' not in HTML_TEMPLATE


def test_generate_thumbnail_uses_temp_file_and_leaves_no_tmp_leftover(tmp_path, monkeypatch):
    """AC 1 & 2: generate_thumbnail writes to a unique temporary file and replaces atomically.
    No .tmp-* files remain after successful generation.
    """
    src = tmp_path / "original.png"
    thumb = tmp_path / "original.thumb.jpg"
    img = Image.new("RGB", (300, 300), color="green")
    img.save(src, format="PNG")

    saved_targets = []
    real_save = Image.Image.save

    def spy_save(self, fp, *args, **kwargs):
        saved_targets.append(str(fp))
        return real_save(self, fp, *args, **kwargs)

    monkeypatch.setattr(Image.Image, "save", spy_save)

    success = generate_thumbnail(src, thumb, max_size=150)
    assert success is True
    assert thumb.exists()

    # The save target was a temporary file, not the final thumb path
    assert len(saved_targets) == 1
    assert ".tmp-" in saved_targets[0]
    assert saved_targets[0] != str(thumb)

    # No .tmp-* files remain in the directory
    tmp_files = [f for f in tmp_path.iterdir() if ".tmp-" in f.name]
    assert len(tmp_files) == 0


def test_thumbnail_failure_preserves_existing_thumb_and_cleans_only_own_tmp(tmp_path, monkeypatch):
    """AC 2: Failure during thumbnail generation does not delete an already-existing thumb_path,
    and cleans up only the temporary file created by that run.
    """
    src = tmp_path / "image.png"
    thumb = tmp_path / "image.thumb.jpg"
    img = Image.new("RGB", (100, 100), color="blue")
    img.save(src, format="PNG")

    # Pre-create a valid existing thumbnail
    thumb.write_bytes(b"pre-existing valid thumbnail content")

    # Simulate failure during generation where a temporary file was written
    save_called = False

    def failing_save(self, fp, *args, **kwargs):
        nonlocal save_called
        save_called = True
        Path(fp).write_bytes(b"partial temp content")
        raise RuntimeError("Simulated crash during save")

    monkeypatch.setattr(Image.Image, "save", failing_save)

    success = generate_thumbnail(src, thumb, max_size=50)
    assert success is False
    assert save_called is True

    # The existing thumbnail MUST still exist and be intact
    assert thumb.exists()
    assert thumb.read_bytes() == b"pre-existing valid thumbnail content"

    # Any temp file created by this run must be cleaned up
    tmp_files = [f for f in tmp_path.iterdir() if ".tmp-" in f.name]
    assert len(tmp_files) == 0


def test_thumbnail_canonical_uuid_form(isolate_data_dir):
    """AC 3: thumb_path uses canonical UUID form, even when requested with non-canonical (e.g. uppercase) file_id.
    Deletion via non-canonical ID also removes the canonical thumb_path.
    """
    raw_uuid = uuid.uuid4()
    canonical_id = str(raw_uuid).lower()
    upper_id = str(raw_uuid).upper()
    filename = "test.png"

    file_path = isolate_data_dir / canonical_id
    meta_path = isolate_data_dir / f"{canonical_id}.meta.json"
    canonical_thumb = isolate_data_dir / f"{canonical_id}.thumb.jpg"
    upper_thumb = isolate_data_dir / f"{upper_id}.thumb.jpg"

    img = Image.new("RGB", (200, 200), color="yellow")
    img.save(file_path, format="PNG")

    meta = FileMetadata(
        file_id=canonical_id,
        filename=filename,
        ttl=3600,
        created_at=time.time(),
    )
    meta.save(meta_path)

    client = TestClient(app)

    # Request thumbnail using UPPERCASE file_id
    res = client.get(f"/t/{upper_id}/{filename}")
    assert res.status_code == 200

    # Thumbnail must be generated using CANONICAL ID, not uppercase ID
    assert canonical_thumb.exists()
    assert not upper_thumb.exists()

    # Deleting using UPPERCASE ID must delete the canonical thumbnail
    deleted = delete_file_by_id(upper_id)
    assert deleted is True
    assert not canonical_thumb.exists()


def test_generate_thumbnail_exif_orientation_transposed(tmp_path):
    """AC 4: generate_thumbnail applies EXIF orientation (e.g. orientation 6 = 90 deg CW rotation).
    The resulting thumbnail has post-rotation dimensions (width/height swapped).
    """
    src = tmp_path / "exif_photo.jpg"
    thumb = tmp_path / "exif_photo.thumb.jpg"

    # Create 600x300 image with EXIF orientation 6 (90 degrees CW)
    img = Image.new("RGB", (600, 300), color="purple")
    exif = img.getexif()
    exif[0x0112] = 6  # Orientation tag
    img.save(src, format="JPEG", exif=exif)

    success = generate_thumbnail(src, thumb, max_size=200)
    assert success is True
    assert thumb.exists()

    with Image.open(thumb) as thumb_img:
        # Without exif_transpose: 600x300 resized to fit 200x200 would be (200, 100).
        # With exif_transpose: image is transposed to 300x600, resized to fit 200x200 it becomes (100, 200).
        assert thumb_img.size == (100, 200)


def test_thumbnail_generation_failure_logs_event(isolate_data_dir, monkeypatch):
    """AC 5: When generate_thumbnail fails, log_event('thumbnail_generation_failed', file_id=..., reason=...) is called."""
    file_id = str(uuid.uuid4())
    filename = "bad.png"
    file_path = isolate_data_dir / file_id
    meta_path = isolate_data_dir / f"{file_id}.meta.json"

    file_path.write_bytes(b"corrupted image content")
    meta = FileMetadata(
        file_id=file_id,
        filename=filename,
        ttl=3600,
        created_at=time.time(),
    )
    meta.save(meta_path)

    events_logged = []
    real_log_event = app_module.log_event

    def spy_log_event(event, **fields):
        events_logged.append((event, fields))
        return real_log_event(event, **fields)

    monkeypatch.setattr(app_module, "log_event", spy_log_event)

    client = TestClient(app)
    res = client.get(f"/t/{file_id}/{filename}")
    assert res.status_code == 200

    # Verify log_event was called with 'thumbnail_generation_failed'
    fail_events = [fields for event, fields in events_logged if event == "thumbnail_generation_failed"]
    assert len(fail_events) == 1
    assert fail_events[0]["file_id"] == file_id
    assert "reason" in fail_events[0]


def test_lazy_expiry_in_download_and_view_cleans_thumbnail(isolate_data_dir):
    """AC 6: Hitting GET /d/... or GET /v/... on an expired file removes .thumb.jpg along with original and meta."""
    client = TestClient(app)

    for route_prefix in ("/d", "/v"):
        file_id = str(uuid.uuid4())
        filename = "photo.png"
        file_path = isolate_data_dir / file_id
        meta_path = isolate_data_dir / f"{file_id}.meta.json"
        thumb_path = isolate_data_dir / f"{file_id}.thumb.jpg"

        # Create original image and pre-generate thumbnail
        img = Image.new("RGB", (100, 100), color="red")
        img.save(file_path, format="PNG")
        thumb_path.write_bytes(b"dummy thumbnail bytes")

        # Expired metadata
        meta = FileMetadata(
            file_id=file_id,
            filename=filename,
            ttl=60,
            created_at=time.time() - 120,
        )
        meta.save(meta_path)

        assert file_path.exists()
        assert meta_path.exists()
        assert thumb_path.exists()

        # Trigger lazy expiry
        res = client.get(f"{route_prefix}/{file_id}/{filename}")
        assert res.status_code == 404

        # Original, metadata AND thumbnail must all be cleaned up
        assert not file_path.exists()
        assert not meta_path.exists()
        assert not thumb_path.exists(), f"Thumbnail was not cleaned up on {route_prefix} lazy-expiry"


def test_thumbnail_second_attempt_uses_fail_cache(isolate_data_dir, monkeypatch):
    """AC 2: A second attempt to generate thumbnail for a file that already failed before
    (marker .thumb.fail present) does NOT call generate_thumbnail again and serves the original file directly.
    """
    file_id = str(uuid.uuid4())
    filename = "vector.svg"
    file_path = isolate_data_dir / file_id
    meta_path = isolate_data_dir / f"{file_id}.meta.json"
    fail_marker = isolate_data_dir / f"{file_id}.thumb.fail"
    thumb_path = isolate_data_dir / f"{file_id}.thumb.jpg"

    original_content = b"<svg><circle cx='50' cy='50' r='40'/></svg>"
    file_path.write_bytes(original_content)
    meta = FileMetadata(
        file_id=file_id,
        filename=filename,
        ttl=3600,
        created_at=time.time(),
    )
    meta.save(meta_path)

    client = TestClient(app)

    # First attempt: generation fails because SVG cannot be decoded by PIL
    res1 = client.get(f"/t/{file_id}/{filename}")
    assert res1.status_code == 200
    assert res1.content == original_content
    # Marker .thumb.fail must be created, and .thumb.jpg must not exist
    assert fail_marker.exists()
    assert not thumb_path.exists()

    # Spy/mock generate_thumbnail to verify call_count
    call_count = 0
    real_generate_thumbnail = app_module.generate_thumbnail

    def mock_generate_thumbnail(*args, **kwargs):
        nonlocal call_count
        call_count += 1
        return real_generate_thumbnail(*args, **kwargs)

    monkeypatch.setattr(app_module, "generate_thumbnail", mock_generate_thumbnail)

    # Second attempt: with .thumb.fail present, generate_thumbnail must NOT be called
    res2 = client.get(f"/t/{file_id}/{filename}")
    assert res2.status_code == 200
    assert res2.content == original_content
    assert call_count == 0


def test_delete_thumbnail_removes_jpg_and_fail_marker(isolate_data_dir):
    """AC 3: _delete_thumbnail removes both .thumb.jpg and .thumb.fail when present,
    and raises no exception when neither exists.
    """
    file_id = str(uuid.uuid4())
    thumb_path = isolate_data_dir / f"{file_id}.thumb.jpg"
    fail_path = isolate_data_dir / f"{file_id}.thumb.fail"

    # Case 1: Neither exists - must execute silently without raising any exception
    _delete_thumbnail(file_id)

    # Case 2: Both exist - must remove both
    thumb_path.write_bytes(b"jpeg-bytes")
    fail_path.write_bytes(b"")
    assert thumb_path.exists()
    assert fail_path.exists()

    _delete_thumbnail(file_id)
    assert not thumb_path.exists()
    assert not fail_path.exists()

    # Case 3: Only .thumb.jpg exists
    thumb_path.write_bytes(b"jpeg-bytes")
    assert thumb_path.exists()
    _delete_thumbnail(file_id)
    assert not thumb_path.exists()

    # Case 4: Only .thumb.fail exists
    fail_path.write_bytes(b"")
    assert fail_path.exists()
    _delete_thumbnail(file_id)
    assert not fail_path.exists()


def test_delete_thumbnail_logs_unexpected_exceptions(isolate_data_dir, monkeypatch):
    """_delete_thumbnail catches FileNotFoundError silently, but logs any other exception via log_event."""
    file_id = str(uuid.uuid4())
    thumb_path = isolate_data_dir / f"{file_id}.thumb.jpg"
    thumb_path.write_bytes(b"content")

    events = []
    real_log = app_module.log_event

    def spy_log(event, **kw):
        events.append((event, kw))
        return real_log(event, **kw)

    monkeypatch.setattr(app_module, "log_event", spy_log)

    def mock_unlink(self, *args, **kwargs):
        raise OSError("Simulated disk error")

    monkeypatch.setattr("pathlib.Path.unlink", mock_unlink)

    # Must not raise, but must log event
    _delete_thumbnail(file_id)
    fail_events = [kw for ev, kw in events if ev == "thumbnail_delete_failed"]
    assert len(fail_events) >= 1
    assert fail_events[0]["file_id"] == file_id
    assert "Simulated disk error" in fail_events[0]["error"]


def test_thumbnail_generation_failure_logs_real_error_details(isolate_data_dir, monkeypatch):
    """AC 4: log_event for thumbnail generation failure includes real error details,
    not just fixed string 'unsupported_format'.
    """
    file_id = str(uuid.uuid4())
    filename = "unsupported.png"
    file_path = isolate_data_dir / file_id
    meta_path = isolate_data_dir / f"{file_id}.meta.json"

    file_path.write_bytes(b"this is corrupt binary payload not an image")
    meta = FileMetadata(
        file_id=file_id,
        filename=filename,
        ttl=3600,
        created_at=time.time(),
    )
    meta.save(meta_path)

    events_logged = []
    real_log_event = app_module.log_event

    def spy_log_event(event, **fields):
        events_logged.append((event, fields))
        return real_log_event(event, **fields)

    monkeypatch.setattr(app_module, "log_event", spy_log_event)

    client = TestClient(app)
    res = client.get(f"/t/{file_id}/{filename}")
    assert res.status_code == 200

    fail_events = [fields for event, fields in events_logged if event == "thumbnail_generation_failed"]
    assert len(fail_events) == 1
    event = fail_events[0]
    assert event["file_id"] == file_id
    # Must NOT be the old generic fixed string "unsupported_format"
    assert event.get("reason") != "unsupported_format"
    # Must include real error details from PIL exception (e.g. "cannot identify image file")
    error_text = event.get("error", "") or event.get("reason", "")
    assert "cannot identify image file" in error_text.lower()


def test_api_files_pagination_defaults_more_than_50(auth_client, isolate_data_dir):
    """GET /api/files without params returns at most 50 items with total, page, page_size, and total_pages."""
    base_time = time.time()
    for i in range(55):
        fid = f"file-{i:03d}"
        meta = FileMetadata(
            file_id=fid,
            filename=f"test_{i:03d}.txt",
            ttl=86400,
            created_at=base_time + i,
            size_bytes=100 + i,
        )
        meta.save(isolate_data_dir / f"{fid}.meta.json")
        (isolate_data_dir / fid).write_bytes(b"x" * (100 + i))

    res = auth_client.get("/api/files")
    assert res.status_code == 200
    data = res.json()
    assert isinstance(data, dict)
    assert len(data["items"]) == 50
    assert data["total"] == 55
    assert data["page"] == 1
    assert data["page_size"] == 50
    assert data["total_pages"] == 2


def test_api_files_pagination_page_2(auth_client, isolate_data_dir):
    """GET /api/files?page=2 returns the next page of items with correct metadata."""
    base_time = time.time()
    for i in range(75):
        fid = f"file-{i:03d}"
        meta = FileMetadata(
            file_id=fid,
            filename=f"file_{i:03d}.txt",
            ttl=86400,
            created_at=base_time + i,
            size_bytes=10,
        )
        meta.save(isolate_data_dir / f"{fid}.meta.json")
        (isolate_data_dir / fid).write_bytes(b"content")

    res_p1 = auth_client.get("/api/files?page=1")
    assert res_p1.status_code == 200
    p1 = res_p1.json()
    assert len(p1["items"]) == 50
    assert p1["page"] == 1
    assert p1["total"] == 75
    assert p1["total_pages"] == 2

    res_p2 = auth_client.get("/api/files?page=2")
    assert res_p2.status_code == 200
    p2 = res_p2.json()
    assert len(p2["items"]) == 25
    assert p2["page"] == 2
    assert p2["total"] == 75
    assert p2["total_pages"] == 2

    p1_ids = {item["id"] for item in p1["items"]}
    p2_ids = {item["id"] for item in p2["items"]}
    assert p1_ids.isdisjoint(p2_ids)
    assert len(p1_ids | p2_ids) == 75


def test_api_files_filter_by_query_q(auth_client, isolate_data_dir):
    """GET /api/files?q=term filters by filename substring (case-insensitive) before paginating."""
    base_time = time.time()
    for i in range(60):
        fid = f"rep-{i:03d}"
        meta = FileMetadata(
            file_id=fid,
            filename=f"Monthly_Report_{i:03d}.pdf",
            ttl=86400,
            created_at=base_time + i,
            size_bytes=50,
        )
        meta.save(isolate_data_dir / f"{fid}.meta.json")
        (isolate_data_dir / fid).write_bytes(b"report-content")

    for i in range(20):
        fid = f"other-{i:03d}"
        meta = FileMetadata(
            file_id=fid,
            filename=f"holiday_photo_{i:03d}.jpg",
            ttl=86400,
            created_at=base_time + 100 + i,
            size_bytes=80,
        )
        meta.save(isolate_data_dir / f"{fid}.meta.json")
        (isolate_data_dir / fid).write_bytes(b"photo-content")

    res = auth_client.get("/api/files?q=REPORT")
    assert res.status_code == 200
    data = res.json()
    assert data["total"] == 60
    assert len(data["items"]) == 50
    assert data["total_pages"] == 2
    assert all("report" in item["filename"].lower() for item in data["items"])

    res_p2 = auth_client.get("/api/files?q=report&page=2")
    assert res_p2.status_code == 200
    data_p2 = res_p2.json()
    assert data_p2["total"] == 60
    assert len(data_p2["items"]) == 10
    assert data_p2["page"] == 2
    assert all("report" in item["filename"].lower() for item in data_p2["items"])


def test_api_files_filter_by_kind(auth_client, isolate_data_dir):
    """GET /api/files?kind=... filters files by file category."""
    files_to_create = [
        ("img1.png", 10),
        ("img2.jpg", 10),
        ("img3.webp", 10),
        ("doc1.pdf", 10),
        ("doc2.docx", 10),
        ("doc3.txt", 10),
        ("vid1.mp4", 10),
        ("vid2.webm", 10),
        ("arc1.zip", 10),
        ("arc2.tar.gz", 10),
    ]
    base_time = time.time()
    for idx, (fname, sz) in enumerate(files_to_create):
        fid = f"kind-test-{idx}"
        meta = FileMetadata(
            file_id=fid,
            filename=fname,
            ttl=86400,
            created_at=base_time + idx,
            size_bytes=sz,
        )
        meta.save(isolate_data_dir / f"{fid}.meta.json")
        (isolate_data_dir / fid).write_bytes(b"x" * sz)

    # Kind image
    res = auth_client.get("/api/files?kind=image")
    assert res.status_code == 200
    data = res.json()
    assert data["total"] == 3
    assert len(data["items"]) == 3
    assert {f["filename"] for f in data["items"]} == {"img1.png", "img2.jpg", "img3.webp"}

    # Kind document
    res_doc = auth_client.get("/api/files?kind=document")
    assert res_doc.status_code == 200
    data_doc = res_doc.json()
    assert data_doc["total"] == 3
    assert {f["filename"] for f in data_doc["items"]} == {"doc1.pdf", "doc2.docx", "doc3.txt"}

    # Kind video
    res_vid = auth_client.get("/api/files?kind=video")
    assert res_vid.status_code == 200
    data_vid = res_vid.json()
    assert data_vid["total"] == 2
    assert {f["filename"] for f in data_vid["items"]} == {"vid1.mp4", "vid2.webm"}

    # Kind archive (catch-all for other extensions)
    res_arc = auth_client.get("/api/files?kind=archive")
    assert res_arc.status_code == 200
    data_arc = res_arc.json()
    assert data_arc["total"] == 2
    assert {f["filename"] for f in data_arc["items"]} == {"arc1.zip", "arc2.tar.gz"}


def test_api_files_sort_name_and_size_and_expiry(auth_client, isolate_data_dir):
    """GET /api/files?sort=... correctly sorts by name, size, expiry, and date."""
    now = time.time()
    # file A: name="Zeta.txt", size=500, expires in 200s (ttl=200, created=now)
    meta_a = FileMetadata("id-a", "Zeta.txt", 200, now, size_bytes=500)
    meta_a.save(isolate_data_dir / "id-a.meta.json")
    (isolate_data_dir / "id-a").write_bytes(b"a" * 500)

    # file B: name="Alpha.txt", size=1000, never expires (ttl=0, created=now - 50)
    meta_b = FileMetadata("id-b", "Alpha.txt", 0, now - 50, size_bytes=1000)
    meta_b.save(isolate_data_dir / "id-b.meta.json")
    (isolate_data_dir / "id-b").write_bytes(b"b" * 1000)

    # file C: name="Beta.txt", size=100, expires in 50s (ttl=50, created=now)
    meta_c = FileMetadata("id-c", "Beta.txt", 50, now, size_bytes=100)
    meta_c.save(isolate_data_dir / "id-c.meta.json")
    (isolate_data_dir / "id-c").write_bytes(b"c" * 100)

    # Sort name: Alpha, Beta, Zeta
    res_name = auth_client.get("/api/files?sort=name")
    assert res_name.status_code == 200
    names = [f["filename"] for f in res_name.json()["items"]]
    assert names == ["Alpha.txt", "Beta.txt", "Zeta.txt"]

    # Sort size: 1000 (Alpha), 500 (Zeta), 100 (Beta)
    res_size = auth_client.get("/api/files?sort=size")
    assert res_size.status_code == 200
    sizes = [f["size_bytes"] for f in res_size.json()["items"]]
    assert sizes == [1000, 500, 100]

    # Sort expiry: Beta (50s), Zeta (200s), Alpha (never expires: -1 at end)
    res_exp = auth_client.get("/api/files?sort=expiry")
    assert res_exp.status_code == 200
    exp_order = [f["filename"] for f in res_exp.json()["items"]]
    assert exp_order == ["Beta.txt", "Zeta.txt", "Alpha.txt"]


def test_api_files_aggregates_reflect_full_filtered_set_and_mcp_paginated(auth_client, isolate_data_dir):
    """total_size_bytes and expiring_soon_count reflect the full filtered set (>50 items) and MCP tool list_files returns paginated format."""
    base_time = time.time()
    # Create 60 image files (each 100 bytes):
    # 30 expiring soon (ttl=1800) and 30 never expiring (ttl=0)
    for i in range(60):
        fid = f"img-{i:03d}"
        ttl = 1800 if i < 30 else 0
        meta = FileMetadata(
            file_id=fid,
            filename=f"photo_{i:03d}.png",
            ttl=ttl,
            created_at=base_time + i,
            size_bytes=100,
        )
        meta.save(isolate_data_dir / f"{fid}.meta.json")
        (isolate_data_dir / fid).write_bytes(b"x" * 100)

    # Create 10 non-image files (each 200 bytes, ttl=1800)
    for i in range(10):
        fid = f"txt-{i:03d}"
        meta = FileMetadata(
            file_id=fid,
            filename=f"doc_{i:03d}.txt",
            ttl=1800,
            created_at=base_time + 100 + i,
            size_bytes=200,
        )
        meta.save(isolate_data_dir / f"{fid}.meta.json")
        (isolate_data_dir / fid).write_bytes(b"y" * 200)

    # 1. Check page 1 with kind=image filter
    res_p1 = auth_client.get("/api/files?kind=image&page=1")
    assert res_p1.status_code == 200
    data_p1 = res_p1.json()
    assert len(data_p1["items"]) == 50
    assert data_p1["total"] == 60
    assert data_p1["page"] == 1
    assert data_p1["page_size"] == 50
    assert data_p1["total_pages"] == 2
    # Full filtered set: 60 images * 100 bytes = 6000 bytes (not just 50 * 100)
    assert data_p1["total_size_bytes"] == 6000
    # Full filtered set: 30 expiring soon images (not just those in page 1)
    assert data_p1["expiring_soon_count"] == 30

    # 2. Check page 2 with kind=image filter
    res_p2 = auth_client.get("/api/files?kind=image&page=2")
    assert res_p2.status_code == 200
    data_p2 = res_p2.json()
    assert len(data_p2["items"]) == 10
    assert data_p2["total"] == 60
    assert data_p2["page"] == 2
    assert data_p2["total_size_bytes"] == 6000
    assert data_p2["expiring_soon_count"] == 30

    # 3. Check MCP list_files() returns paginated format (max 50 items)
    mcp_res = list_files()
    assert isinstance(mcp_res, dict)
    assert len(mcp_res["items"]) == 50
    assert mcp_res["total"] == 70
    assert mcp_res["page"] == 1
    assert mcp_res["page_size"] == 50
    assert mcp_res["total_pages"] == 2
    assert all("id" in f and "filename" in f for f in mcp_res["items"])


def test_html_template_pagination_logic():
    """AC 3: HTML_TEMPLATE contains pagination UI and client-side logic."""
    # Pagination controls: Anterior and Proxima buttons
    assert "Anterior" in HTML_TEMPLATE
    assert "Proxima" in HTML_TEMPLATE
    assert "prevPageBtn" in HTML_TEMPLATE
    assert "nextPageBtn" in HTML_TEMPLATE

    # Fetch with query params in loadFiles()
    assert "/api/files?" in HTML_TEMPLATE or "URLSearchParams" in HTML_TEMPLATE

    # Reset to page 1 on filter/search/sort change
    assert "currentPage = 1" in HTML_TEMPLATE


def test_html_template_debounce_token_and_page_clamp():
    """AC 3: HTML_TEMPLATE contains search debounce (~300ms), request token for out-of-order protection, and currentPage clamp."""
    # Debounce with setTimeout/clearTimeout around searchInput handler
    assert "searchDebounceTimer" in HTML_TEMPLATE
    assert "clearTimeout(searchDebounceTimer)" in HTML_TEMPLATE
    assert "setTimeout" in HTML_TEMPLATE
    assert "300" in HTML_TEMPLATE

    # Request counter / token logic to drop out-of-order responses
    assert "loadFilesRequestId" in HTML_TEMPLATE
    assert "requestId !== loadFilesRequestId" in HTML_TEMPLATE

    # currentPage clamp logic when current page exceeds total_pages
    assert "Math.min(currentPage" in HTML_TEMPLATE
    assert "currentPage > validPage" in HTML_TEMPLATE or "currentPage !== validPage" in HTML_TEMPLATE


def test_expiring_soon_count_boundary_condition(auth_client, isolate_data_dir, monkeypatch):
    """expiring_soon_count uses strictly < 3600 condition (boundary test for exactly 3600s vs 3599s)."""
    base_time = 1_000_000.0
    monkeypatch.setattr("time.time", lambda: base_time)

    # File 1: expires in exactly 3600s -> NOT expiring soon (< 3600)
    fid1 = "f-boundary-3600"
    meta1 = FileMetadata(
        file_id=fid1,
        filename="file3600.txt",
        ttl=3600,
        created_at=base_time,
        size_bytes=10,
    )
    meta1.save(isolate_data_dir / f"{fid1}.meta.json")
    (isolate_data_dir / fid1).write_bytes(b"a" * 10)

    # File 2: expires in 3599s -> IS expiring soon (< 3600)
    fid2 = "f-boundary-3599"
    meta2 = FileMetadata(
        file_id=fid2,
        filename="file3599.txt",
        ttl=3600,
        created_at=base_time - 1,
        size_bytes=10,
    )
    meta2.save(isolate_data_dir / f"{fid2}.meta.json")
    (isolate_data_dir / fid2).write_bytes(b"b" * 10)

    # File 3: never expires (ttl=0, expires_in=-1)
    fid3 = "f-boundary-never"
    meta3 = FileMetadata(
        file_id=fid3,
        filename="filenever.txt",
        ttl=0,
        created_at=base_time,
        size_bytes=10,
    )
    meta3.save(isolate_data_dir / f"{fid3}.meta.json")
    (isolate_data_dir / fid3).write_bytes(b"c" * 10)

    res = auth_client.get("/api/files")
    assert res.status_code == 200
    data = res.json()
    items_by_id = {f["id"]: f for f in data["items"]}
    assert items_by_id[fid1]["expires_in"] == 3600
    assert items_by_id[fid2]["expires_in"] == 3599
    assert items_by_id[fid3]["expires_in"] == -1
    # Exactly 3600s must NOT be counted in expiring_soon_count (< 3600)
    assert data["expiring_soon_count"] == 1


def test_mcp_setup_unauthenticated():
    client = TestClient(app)
    # Browser request (Accept: text/html) redirects to /auth/login
    res_browser = client.get("/mcp-setup", headers={"Accept": "text/html"}, follow_redirects=False)
    assert res_browser.status_code == 302
    assert res_browser.headers["location"] == "/auth/login"

    # API client request returns 401
    res_api = client.get("/mcp-setup")
    assert res_api.status_code == 401
    assert res_api.json()["error"] == "unauthorized"


def test_mcp_setup_authenticated(auth_client, monkeypatch):
    secret_key = "super-secret-mcp-key-xyz-987"
    monkeypatch.setenv("TMPUP_API_KEYS", secret_key)
    monkeypatch.setattr("app.API_KEYS", {secret_key, "test-key"})

    res = auth_client.get("/mcp-setup")
    assert res.status_code == 200
    assert "text/html" in res.headers.get("content-type", "")

    html = res.text

    # 1) Endpoint real: BASE_URL + '/mcp'
    expected_endpoint = f"{BASE_URL}/mcp"
    assert expected_endpoint in html

    # 2) 5 tools with names and their docstrings
    expected_tools = [
        ("upload_file", "Upload a file encoded in base64 with TTL in seconds (0 = never expires)."),
        ("list_files", "List active (non-expired) files with metadata."),
        ("get_file_info", "Get metadata for a specific active file."),
        ("extend_ttl", "Extend or update TTL for an existing file."),
        ("delete_file", "Delete a file by ID."),
    ]
    for tool_name, tool_desc in expected_tools:
        assert tool_name in html
        assert tool_desc in html

    # 3) JSON example with X-API-Key and BASE_URL/mcp
    assert '"mcpServers"' in html
    assert '"tmpup"' in html
    assert '"type": "http"' in html
    assert "X-API-Key" in html
    assert "SUA_CHAVE_AQUI" in html

    # 4) Page NEVER contains the real value of TMPUP_API_KEYS
    assert secret_key not in html


def test_mcp_link_in_html_template(auth_client):
    res = auth_client.get("/")
    assert res.status_code == 200
    assert 'href="/mcp-setup"' in res.text
    assert "MCP" in res.text
    assert 'href="/mcp-setup"' in HTML_TEMPLATE


def test_mcp_list_files_paginated_over_50_items(isolate_data_dir):
    """Calling list_files() without args with >50 active files returns at most 50 items in paginated format."""
    base_time = time.time()
    for i in range(55):
        fid = f"file-{i:03d}"
        meta = FileMetadata(
            file_id=fid,
            filename=f"item_{i:03d}.txt",
            ttl=0,
            created_at=base_time + i,
            size_bytes=10,
        )
        meta.save(isolate_data_dir / f"{fid}.meta.json")
        (isolate_data_dir / fid).write_bytes(b"0123456789")

    res = list_files()
    assert isinstance(res, dict)
    assert res["page"] == 1
    assert res["page_size"] == 50
    assert res["total"] == 55
    assert res["total_pages"] == 2
    assert len(res["items"]) == 50
    assert res["total_size_bytes"] == 550
    assert res["expiring_soon_count"] == 0


def test_mcp_list_files_search_query(isolate_data_dir):
    """list_files(q='term') filters by substring in filename before paginating."""
    base_time = time.time()
    files = [
        ("f-1", "report_2024.pdf"),
        ("f-2", "report_2025.txt"),
        ("f-3", "notes.doc"),
    ]
    for fid, name in files:
        meta = FileMetadata(file_id=fid, filename=name, ttl=0, created_at=base_time, size_bytes=10)
        meta.save(isolate_data_dir / f"{fid}.meta.json")
        (isolate_data_dir / fid).write_bytes(b"x" * 10)

    res_report = list_files(q="report")
    assert isinstance(res_report, dict)
    assert res_report["total"] == 2
    assert len(res_report["items"]) == 2
    filenames = [f["filename"] for f in res_report["items"]]
    assert "report_2024.pdf" in filenames
    assert "report_2025.txt" in filenames

    res_2025 = list_files(q="2025")
    assert res_2025["total"] == 1
    assert len(res_2025["items"]) == 1
    assert res_2025["items"][0]["filename"] == "report_2025.txt"

    res_none = list_files(q="nonexistent")
    assert res_none["total"] == 0
    assert res_none["items"] == []


def test_mcp_list_files_filter_kind(isolate_data_dir):
    """list_files(kind='image') only returns image files."""
    base_time = time.time()
    files = [
        ("f-img1", "photo.png"),
        ("f-img2", "diagram.jpg"),
        ("f-doc", "doc.txt"),
        ("f-zip", "archive.zip"),
    ]
    for fid, name in files:
        meta = FileMetadata(file_id=fid, filename=name, ttl=0, created_at=base_time, size_bytes=20)
        meta.save(isolate_data_dir / f"{fid}.meta.json")
        (isolate_data_dir / fid).write_bytes(b"y" * 20)

    res_img = list_files(kind="image")
    assert isinstance(res_img, dict)
    assert res_img["total"] == 2
    assert len(res_img["items"]) == 2
    img_names = {f["filename"] for f in res_img["items"]}
    assert img_names == {"photo.png", "diagram.jpg"}

    res_doc = list_files(kind="document")
    assert res_doc["total"] == 1
    assert res_doc["items"][0]["filename"] == "doc.txt"


def test_mcp_list_files_pagination_page_2(isolate_data_dir):
    """list_files(page=2) returns the next page of results."""
    base_time = time.time()
    for i in range(60):
        fid = f"page-f-{i:03d}"
        meta = FileMetadata(
            file_id=fid,
            filename=f"data_{i:03d}.bin",
            ttl=0,
            created_at=base_time + i,
            size_bytes=5,
        )
        meta.save(isolate_data_dir / f"{fid}.meta.json")
        (isolate_data_dir / fid).write_bytes(b"12345")

    p1 = list_files(page=1)
    p2 = list_files(page=2)

    assert p1["page"] == 1
    assert len(p1["items"]) == 50
    assert p1["total"] == 60
    assert p1["total_pages"] == 2

    assert p2["page"] == 2
    assert len(p2["items"]) == 10
    assert p2["total"] == 60
    assert p2["total_pages"] == 2

    p1_ids = {f["id"] for f in p1["items"]}
    p2_ids = {f["id"] for f in p2["items"]}
    assert p1_ids.isdisjoint(p2_ids)
    assert len(p1_ids | p2_ids) == 60


@pytest.mark.asyncio
async def test_mcp_list_files_matches_api_list_files(isolate_data_dir):
    """list_files() and api_list_files() yield identical results for the same parameters."""
    base_time = time.time()
    # Create 65 files with different kinds, names, sizes, creation times and ttls
    for i in range(65):
        ext = ["png", "txt", "zip", "mp4"][i % 4]
        fid = f"mix-{i:03d}"
        meta = FileMetadata(
            file_id=fid,
            filename=f"item_{65 - i:03d}.{ext}",
            ttl=1800 if i % 3 == 0 else 0,
            created_at=base_time + (i * 10),
            size_bytes=(i + 1) * 100,
        )
        meta.save(isolate_data_dir / f"{fid}.meta.json")
        (isolate_data_dir / fid).write_bytes(b"x" * 10)

    test_cases = [
        {},
        {"page": 2},
        {"q": "item_01"},
        {"kind": "image"},
        {"kind": "document", "page": 1},
        {"sort": "name"},
        {"sort": "size"},
        {"sort": "expiry"},
        {"sort": "date", "page": 2},
        {"q": "item", "kind": "archive", "sort": "size", "page": 1},
    ]

    def _strip_dynamic_fields(res):
        return {
            **res,
            "items": [
                {k: v for k, v in item.items() if k not in ("expires_in", "last_viewed_at", "last_downloaded_at")}
                for item in res.get("items", [])
            ],
        }

    for kwargs in test_cases:
        mcp_res = list_files(**kwargs)
        api_res = await api_list_files(**kwargs)
        assert _strip_dynamic_fields(mcp_res) == _strip_dynamic_fields(api_res), f"Mismatch for kwargs: {kwargs}"


def test_mcp_list_files_docstring():
    """list_files docstring clarifies q, kind, page, and get_file_info."""
    doc = list_files.__doc__ or ""
    assert "(q)" in doc or "q:" in doc
    assert "kind:" in doc
    assert "(page" in doc or "page:" in doc
    assert "get_file_info" in doc


def test_filter_sort_paginate_files_unit():
    """Direct unit tests for _filter_sort_paginate_files function."""
    files = [
        {"filename": "a.txt", "size_bytes": 100, "expires_in": 10, "created_at": 1},
        {"filename": "b.jpg", "size_bytes": 500, "expires_in": -1, "created_at": 2},
        {"filename": "c.zip", "size_bytes": 200, "expires_in": 5000, "created_at": 3},
    ]

    # Test empty list
    res_empty = _filter_sort_paginate_files([])
    assert res_empty["items"] == []
    assert res_empty["total"] == 0
    assert res_empty["total_pages"] == 0
    assert res_empty["total_size_bytes"] == 0
    assert res_empty["expiring_soon_count"] == 0

    # Test page clamp (< 1 becomes 1)
    res_clamp = _filter_sort_paginate_files(files, page=0)
    assert res_clamp["page"] == 1
    assert len(res_clamp["items"]) == 3

    # Test kind filter
    res_kind = _filter_sort_paginate_files(files, kind="image")
    assert len(res_kind["items"]) == 1
    assert res_kind["items"][0]["filename"] == "b.jpg"

    # Test sort by size descending
    res_sort_size = _filter_sort_paginate_files(files, sort="size")
    assert [f["filename"] for f in res_sort_size["items"]] == ["b.jpg", "c.zip", "a.txt"]

    # Test expiring_soon_count: expires_in between 0 and 3600 (only a.txt has 10s)
    assert res_sort_size["expiring_soon_count"] == 1
    assert res_sort_size["total_size_bytes"] == 800
