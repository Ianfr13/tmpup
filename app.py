"""
Temporary File Upload Service
Lightweight service for temporary file storage with auto-expiration
"""
import asyncio
import base64
from contextlib import AsyncExitStack
import html
import json
import mimetypes
import os
import threading
import time
import uuid
from pathlib import Path
from typing import Optional
from urllib.parse import quote as urlquote, unquote, urlencode

import httpx
from fastapi import FastAPI, Request, Response, HTTPException
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, RedirectResponse
from itsdangerous import URLSafeTimedSerializer, SignatureExpired, BadSignature
from mcp.server import MCPServer
from starlette.concurrency import run_in_threadpool
from starlette.middleware.base import BaseHTTPMiddleware
import uvicorn

BASE_URL = os.environ.get("BASE_URL", "https://tmpup.douravita.com.br")

# ---------------------------------------------------------------------------
# Auth config
# ---------------------------------------------------------------------------
SECRET_KEY = os.environ.get("SECRET_KEY", "")
GOOGLE_CLIENT_ID = os.environ.get("GOOGLE_CLIENT_ID", "")
GOOGLE_CLIENT_SECRET = os.environ.get("GOOGLE_CLIENT_SECRET", "")
ALLOWED_DOMAIN = "douravita.com.br"
SESSION_MAX_AGE = 86400 * 7  # 7 days
MAX_MCP_UPLOAD_SIZE = 200 * 1024 * 1024  # 200MB limit for MCP upload tool

# ponytail: single global lock, not per-file -- writes are rare/fast (TTL
# renew, view/download counters), so contention is a non-issue. Guards the
# read-modify-write of an existing file's metadata sidecar now that routes
# run concurrently via run_in_threadpool.
_metadata_lock = threading.Lock()

# API-key auth alternativa pra clients headless (pipeline UGC, scripts, CI).
# Comma-separated lista de chaves válidas em TMPUP_API_KEYS.
# Vazio = API-key auth desabilitada (só cookie de sessão funciona).
import secrets as _secrets
_API_KEYS_RAW = os.environ.get("TMPUP_API_KEYS", "").strip()
API_KEYS: set[str] = {k.strip() for k in _API_KEYS_RAW.split(",") if k.strip()}

_serializer = URLSafeTimedSerializer(SECRET_KEY)

PUBLIC_PATHS = {"/health", "/auth/login", "/auth/google", "/auth/callback", "/auth/logout"}


def create_session(email: str) -> str:
    return _serializer.dumps(email)


def verify_session(token: str) -> Optional[str]:
    try:
        return _serializer.loads(token, max_age=SESSION_MAX_AGE)
    except (SignatureExpired, BadSignature):
        return None


def verify_api_key(request: Request) -> Optional[str]:
    """Valida X-API-Key header (constant-time compare).

    Retorna o nome simbólico do client autenticado ('api-key-client') quando
    a chave bate com qualquer entry de TMPUP_API_KEYS. None caso contrário
    (ou se TMPUP_API_KEYS não está configurado).
    """
    if not API_KEYS:
        return None
    provided = request.headers.get("X-API-Key", "")
    if not provided:
        return None
    for valid_key in API_KEYS:
        if _secrets.compare_digest(provided, valid_key):
            return "api-key-client"
    return None


class AuthMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        path = request.url.path
        if path in PUBLIC_PATHS or path.startswith("/d/") or path.startswith("/v/"):
            return await call_next(request)

        # 1) Tenta cookie de sessão (browser flow)
        email = verify_session(request.cookies.get("session", ""))
        if email:
            return await call_next(request)

        # 2) Tenta X-API-Key (headless flow — pipeline UGC, scripts)
        if verify_api_key(request):
            return await call_next(request)

        # 3) Browser → redireciona pro login; API client → 401 JSON
        accept = request.headers.get("accept", "")
        if "text/html" in accept:
            return RedirectResponse("/auth/login", status_code=302)
        return JSONResponse(
            {"error": "unauthorized", "detail": "Provide session cookie or X-API-Key header"},
            status_code=401,
        )


app = FastAPI(title="TmpUp", description="Temporary File Upload Service")
app.add_middleware(AuthMiddleware)

DATA_DIR = Path("/data")
DATA_DIR.mkdir(exist_ok=True)

CLEANUP_INTERVAL = 60  # seconds


# ---------------------------------------------------------------------------
# HTML Frontend Template
# ---------------------------------------------------------------------------
HTML_TEMPLATE = """<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>TmpUp - Upload Temporario</title>
<style>
  *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
  body{
    font-family:system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
    background:#0f0f0f;color:#e5e5e5;min-height:100vh;
    display:flex;flex-direction:column;align-items:center;
    padding:24px 16px;
  }
  a{color:#3b82f6}
  a:hover{color:#60a5fa}
  h1{font-size:1.8rem;font-weight:700;margin-bottom:4px;color:#fff}
  .subtitle{color:#737373;font-size:.9rem;margin-bottom:14px}
  .container{width:100%;max-width:640px}

  .summary-bar{text-align:center;font-size:.82rem;color:#737373;margin-bottom:18px}
  .summary-bar strong{color:#e5e5e5;font-weight:600}
  .summary-warn{color:#fbbf24}

  /* Drop zone */
  .dropzone{
    border:2px dashed #333;border-radius:16px;padding:48px 24px;
    text-align:center;cursor:pointer;transition:all .2s;
    background:#1a1a1a;position:relative;
  }
  .dropzone.dragover{border-color:#3b82f6;background:#1a1a2e}
  .dropzone:hover{border-color:#555}
  .dropzone-icon{width:40px;height:40px;color:#525252;margin-bottom:12px}
  .dropzone-text{color:#a3a3a3;font-size:.95rem;line-height:1.6}
  .dropzone-text strong{color:#e5e5e5}
  .dropzone input[type=file]{position:absolute;inset:0;opacity:0;cursor:pointer}
  .dropzone-hint{font-size:.8rem;color:#525252;margin-top:4px}

  /* TTL selector */
  .controls{display:flex;gap:12px;margin-top:16px;align-items:center;flex-wrap:wrap;justify-content:center}
  .controls label{color:#a3a3a3;font-size:.85rem;display:flex;align-items:center;gap:6px}
  .controls select{background:#262626;color:#e5e5e5;border:1px solid #333;border-radius:8px;padding:8px 12px;font-size:.85rem;cursor:pointer;outline:none}
  .controls select:focus{border-color:#3b82f6}
  .btn-upload{background:#3b82f6;color:#fff;border:none;border-radius:8px;padding:10px 24px;font-size:.9rem;font-weight:600;cursor:pointer;transition:background .15s}
  .btn-upload:hover{background:#2563eb}
  .btn-upload:disabled{opacity:.5;cursor:not-allowed}

  /* Progress */
  .progress-wrap{margin-top:16px;display:none}
  .progress-wrap.active{display:block}
  .progress-bar-bg{width:100%;height:8px;background:#262626;border-radius:4px;overflow:hidden}
  .progress-bar{height:100%;width:0;background:linear-gradient(90deg,#3b82f6,#60a5fa);border-radius:4px;transition:width .2s}
  .progress-text{text-align:center;color:#a3a3a3;font-size:.8rem;margin-top:6px}

  /* Status message */
  .status{margin-top:12px;text-align:center;font-size:.85rem;min-height:20px}
  .status.error{color:#ef4444}
  .status.success{color:#22c55e}

  /* Filter bar */
  .filter-bar{margin-top:32px;display:flex;flex-direction:column;gap:10px}
  .search-wrap{position:relative}
  .search-icon{position:absolute;left:12px;top:50%;transform:translateY(-50%);width:16px;height:16px;color:#525252;pointer-events:none}
  .search-input{width:100%;background:#1a1a1a;border:1px solid #262626;border-radius:8px;padding:9px 12px 9px 34px;font-size:.85rem;color:#e5e5e5;outline:none}
  .search-input:focus{border-color:#3b82f6}
  .search-input::placeholder{color:#525252}
  .filter-row2{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
  .chip-row{display:flex;gap:8px;flex-wrap:wrap}
  .chip{background:#1a1a1a;border:1px solid #262626;border-radius:999px;padding:6px 14px;font-size:.8rem;color:#a3a3a3;cursor:pointer}
  .chip.active{background:rgba(59,130,246,.15);border-color:#3b82f6;color:#60a5fa}
  .sort-select{margin-left:auto;background:#1a1a1a;color:#a3a3a3;border:1px solid #262626;border-radius:8px;padding:6px 10px;font-size:.8rem}

  /* Bulk bar */
  .bulk-bar{display:none;align-items:center;gap:10px;flex-wrap:wrap;background:rgba(59,130,246,.1);border:1px solid rgba(59,130,246,.35);border-radius:10px;padding:10px 14px;margin-top:14px;font-size:.82rem;color:#93c5fd}
  .bulk-bar.active{display:flex}
  .bulk-bar .spacer{flex:1}
  .bulk-btn{background:#262626;border:1px solid #333;border-radius:7px;padding:6px 12px;font-size:.78rem;color:#e5e5e5;cursor:pointer;display:inline-flex;align-items:center;gap:5px}
  .bulk-btn svg{width:13px;height:13px}
  .bulk-btn.danger{color:#fca5a5}
  .bulk-btn.danger:hover{background:rgba(239,68,68,.14);border-color:#ef4444}
  .bulk-cancel{background:none;border:none;color:#93c5fd;font-size:.78rem;cursor:pointer;text-decoration:underline}

  /* File list */
  .file-list{margin-top:20px}
  .file-list h2{font-size:1.1rem;color:#fff;margin-bottom:12px;display:flex;align-items:center;gap:8px}
  .file-list h2 svg{width:18px;height:18px;color:#737373}
  .file-card{background:#1a1a1a;border:1px solid #262626;border-radius:12px;padding:14px 16px;margin-bottom:10px;display:flex;align-items:center;gap:12px;transition:border-color .15s}
  .file-card:hover{border-color:#333}
  .file-lead{display:flex;align-items:center;gap:12px;flex-shrink:0}
  .select-box{width:16px;height:16px;accent-color:#3b82f6;cursor:pointer;flex-shrink:0}
  .file-icon{font-size:1.5rem;flex-shrink:0}
  .file-info{flex:1;min-width:0}
  .file-name{font-size:.9rem;font-weight:500;color:#e5e5e5;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .file-meta{font-size:.75rem;color:#737373;margin-top:2px;display:flex;gap:12px;flex-wrap:wrap}
  .file-meta span{display:inline-flex;align-items:center;gap:4px}
  .file-meta svg{width:12px;height:12px}
  .file-meta .soon{color:#fbbf24}
  .file-metrics{font-size:.72rem;color:#525252;margin-top:4px;display:flex;flex-direction:column;gap:2px}
  .file-metrics span{display:inline-flex;align-items:center;gap:4px}
  .file-metrics svg{width:11px;height:11px;flex-shrink:0}
  .file-metrics .zero{color:#3f3f3f}
  .renew-row{margin-top:8px;display:flex;gap:6px;flex-wrap:wrap}
  .renew-chip{background:#0f0f0f;border:1px solid #3b82f6;color:#93c5fd;border-radius:999px;padding:4px 10px;font-size:.72rem;cursor:pointer}
  .renew-chip:hover{background:rgba(59,130,246,.15)}
  .file-actions{display:flex;gap:6px;flex-shrink:0}
  .btn-icon{background:#262626;border:1px solid #333;border-radius:8px;padding:8px 10px;cursor:pointer;font-size:.85rem;color:#e5e5e5;transition:all .15s;text-decoration:none;display:inline-flex;align-items:center;gap:4px}
  .btn-icon:hover{background:#333;border-color:#444}
  .btn-icon svg{width:14px;height:14px}
  .btn-icon.copied{background:#166534;border-color:#22c55e;color:#22c55e}
  .btn-icon.active{background:rgba(59,130,246,.15);border-color:#3b82f6;color:#60a5fa}
  .btn-icon.danger{color:#fca5a5}
  .btn-icon.danger:hover{background:rgba(239,68,68,.12);border-color:#ef4444}
  .btn-icon.danger-confirm{background:#7f1d1d;border-color:#ef4444;color:#fecaca}
  .file-thumb{width:44px;height:44px;object-fit:cover;border-radius:8px;flex-shrink:0;border:1px solid #333;background:#262626}
  .empty-state{text-align:center;color:#525252;padding:32px;font-size:.9rem}

  @media(max-width:480px){
    .dropzone{padding:32px 16px}
    .file-card{flex-direction:column;align-items:flex-start;gap:8px}
    .file-actions{width:100%;justify-content:flex-end}
    .sort-select{margin-left:0}
  }

  .toast{position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:#166534;color:#22c55e;padding:10px 20px;border-radius:8px;font-size:.85rem;opacity:0;transition:opacity .3s;pointer-events:none;border:1px solid #22c55e;z-index:999}
  .toast.show{opacity:1}
</style>
</head>
<body>

<div style="position:absolute;top:16px;right:16px;display:flex;align-items:center;gap:10px">
  <span id="userEmail" style="color:#525252;font-size:.8rem"></span>
  <a href="/auth/logout" style="color:#737373;font-size:.8rem;text-decoration:none;border:1px solid #333;border-radius:6px;padding:4px 10px;transition:all .15s" onmouseover="this.style.color='#e5e5e5'" onmouseout="this.style.color='#737373'">Sair</a>
</div>
<h1>TmpUp</h1>
<p class="subtitle">Upload temporario de arquivos</p>

<div class="container">
  <div class="summary-bar" id="summaryBar"></div>

  <div class="dropzone" id="dropzone">
    <input type="file" id="fileInput" multiple>
    <svg class="dropzone-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M7 18a4.5 4.5 0 0 1-.4-8.98A5.5 5.5 0 0 1 17.4 8.02 4 4 0 0 1 17 16"/><path d="M12 12v8"/><path d="m9 15 3-3 3 3"/></svg>
    <div class="dropzone-text">
      <strong>Arraste arquivos aqui</strong><br>
      ou clique para selecionar
    </div>
    <div class="dropzone-hint">sem limite de tamanho &middot; ou cole com Ctrl+V</div>
  </div>

  <div class="controls">
    <label for="ttlSelect"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg> Expira em:</label>
    <select id="ttlSelect">
      <option value="0" selected>Nunca expira</option>
      <option value="3600">1 hora</option>
      <option value="21600">6 horas</option>
      <option value="86400">24 horas</option>
      <option value="259200">3 dias</option>
      <option value="604800">7 dias</option>
    </select>
    <button class="btn-upload" id="btnUpload" disabled>Enviar</button>
  </div>

  <div class="progress-wrap" id="progressWrap">
    <div class="progress-bar-bg"><div class="progress-bar" id="progressBar"></div></div>
    <div class="progress-text" id="progressText">Enviando...</div>
  </div>

  <div class="status" id="status"></div>

  <div class="filter-bar">
    <div class="search-wrap">
      <svg class="search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>
      <input class="search-input" id="searchInput" placeholder="Buscar por nome...">
    </div>
    <div class="filter-row2">
      <div class="chip-row" id="chipRow">
        <button class="chip active" data-kind="all">Todos</button>
        <button class="chip" data-kind="image">Imagens</button>
        <button class="chip" data-kind="document">Documentos</button>
        <button class="chip" data-kind="video">Videos</button>
        <button class="chip" data-kind="archive">Outros</button>
      </div>
      <select class="sort-select" id="sortSelect">
        <option value="date">Mais recente</option>
        <option value="name">Nome A-Z</option>
        <option value="size">Maior tamanho</option>
        <option value="expiry">Expira antes</option>
      </select>
    </div>
  </div>

  <div class="bulk-bar" id="bulkBar">
    <span id="bulkCount">0 selecionado(s)</span>
    <div class="spacer"></div>
    <button class="bulk-btn" id="bulkRenewBtn">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 0 1 15.4-6.4L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15.4 6.4L3 16"/><path d="M3 21v-5h5"/></svg>
      Renovar
    </button>
    <button class="bulk-btn danger" id="bulkDeleteBtn">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M4 7h16M9 7V4h6v3m-8 0 1 13h8l1-13"/></svg>
      Excluir
    </button>
    <button class="bulk-cancel" id="bulkCancelBtn">cancelar</button>
  </div>

  <div class="file-list" id="fileListSection">
    <h2>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>
      Arquivos enviados
    </h2>
    <div id="fileList"></div>
  </div>
</div>

<div class="toast" id="toast"></div>

<script>
(function(){
  const dropzone = document.getElementById('dropzone');
  const fileInput = document.getElementById('fileInput');
  const ttlSelect = document.getElementById('ttlSelect');
  const btnUpload = document.getElementById('btnUpload');
  const progressWrap = document.getElementById('progressWrap');
  const progressBar = document.getElementById('progressBar');
  const progressText = document.getElementById('progressText');
  const statusEl = document.getElementById('status');
  const fileList = document.getElementById('fileList');
  const toast = document.getElementById('toast');
  const summaryBar = document.getElementById('summaryBar');
  const searchInput = document.getElementById('searchInput');
  const chipRow = document.getElementById('chipRow');
  const sortSelect = document.getElementById('sortSelect');
  const bulkBar = document.getElementById('bulkBar');
  const bulkCount = document.getElementById('bulkCount');

  let selectedFiles = [];
  let allFiles = [];          // raw list from GET /api/files
  let currentFilter = 'all';
  let currentQuery = '';
  let currentSort = 'date';
  let selectedIds = new Set();
  let confirmingId = null;    // delete confirm state
  let renewingId = null;      // renew popover state

  // --- Drag & Drop ---
  ['dragenter','dragover'].forEach(e => dropzone.addEventListener(e, ev => { ev.preventDefault(); dropzone.classList.add('dragover'); }));
  ['dragleave','drop'].forEach(e => dropzone.addEventListener(e, ev => { ev.preventDefault(); dropzone.classList.remove('dragover'); }));
  dropzone.addEventListener('drop', ev => { const files = Array.from(ev.dataTransfer.files); if(files.length) setFiles(files); });
  fileInput.addEventListener('change', () => { const files = Array.from(fileInput.files); if(files.length) setFiles(files); });

  // --- Paste to upload ---
  window.addEventListener('paste', ev => {
    const items = (ev.clipboardData && ev.clipboardData.items) || [];
    const imageItem = Array.from(items).find(it => it.type && it.type.startsWith('image/'));
    if(!imageItem) return;
    const blob = imageItem.getAsFile();
    if(!blob) return;
    const ext = (blob.type.split('/')[1] || 'png').split('+')[0];
    const file = new File([blob], `print-colado-${Date.now()}.${ext}`, { type: blob.type });
    setFiles([file]);
    uploadNow();
  });

  function setFiles(files) {
    selectedFiles = files;
    btnUpload.disabled = false;
    const names = files.map(f => f.name).join(', ');
    statusEl.className = 'status';
    statusEl.textContent = files.length === 1
      ? `Selecionado: ${names} (${formatSize(files[0].size)})`
      : `${files.length} arquivos selecionados`;
  }

  btnUpload.addEventListener('click', uploadNow);

  async function uploadNow() {
    if(!selectedFiles.length) return;
    btnUpload.disabled = true;
    const ttl = ttlSelect.value;
    let uploaded = 0;
    for(const file of selectedFiles) {
      await uploadOne(file, ttl, selectedFiles.length, ++uploaded);
    }
    selectedFiles = [];
    fileInput.value = '';
    btnUpload.disabled = true;
    loadFiles();
  }

  async function uploadOne(file, ttl, total, idx) {
    progressWrap.classList.add('active');
    progressBar.style.width = '0%';
    const prefix = total > 1 ? `[${idx}/${total}] ` : '';
    progressText.textContent = `${prefix}Enviando ${file.name}...`;
    statusEl.className = 'status';
    statusEl.textContent = '';
    try {
      await new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', '/api/upload');
        xhr.setRequestHeader('X-Filename', encodeURIComponent(file.name));
        xhr.setRequestHeader('X-TTL', ttl);
        xhr.upload.addEventListener('progress', ev => {
          if(ev.lengthComputable) {
            const pct = Math.round((ev.loaded / ev.total) * 100);
            progressBar.style.width = pct + '%';
            progressText.textContent = `${prefix}Enviando ${file.name}... ${pct}%`;
          }
        });
        xhr.addEventListener('load', () => {
          if(xhr.status >= 200 && xhr.status < 300) resolve(JSON.parse(xhr.responseText));
          else { let msg = 'Upload failed'; try { msg = JSON.parse(xhr.responseText).detail || msg; } catch(e){} reject(new Error(msg)); }
        });
        xhr.addEventListener('error', () => reject(new Error('Erro de rede')));
        xhr.send(file);
      });
      progressBar.style.width = '100%';
      progressText.textContent = `${prefix}Concluido!`;
      statusEl.className = 'status success';
      statusEl.textContent = `${file.name} enviado com sucesso!`;
      setTimeout(() => progressWrap.classList.remove('active'), 1500);
    } catch(err) {
      progressWrap.classList.remove('active');
      statusEl.className = 'status error';
      statusEl.textContent = `Erro: ${err.message}`;
    }
  }

  // --- File list (from real API) ---
  async function loadFiles() {
    try {
      const res = await fetch('/api/files');
      if(!res.ok) {
        fileList.innerHTML = '<div class="empty-state">Erro ao carregar arquivos</div>';
        return;
      }
      const data = await res.json();
      if(!Array.isArray(data)) {
        fileList.innerHTML = '<div class="empty-state">Erro ao carregar arquivos</div>';
        return;
      }
      allFiles = data;
      render();
    } catch(e) {
      fileList.innerHTML = '<div class="empty-state">Erro ao carregar arquivos</div>';
    }
  }

  function fileKind(filename) {
    const ext = (filename.split('.').pop() || '').toLowerCase();
    if(['png','jpg','jpeg','gif','webp','svg','bmp','avif'].includes(ext)) return 'image';
    if(['pdf','doc','docx','txt'].includes(ext)) return 'document';
    if(['mp4','mov','avi','mkv','webm'].includes(ext)) return 'video';
    return 'archive'; // catch-all "Outros"
  }

  function render() {
    renderSummary();
    const q = currentQuery.trim().toLowerCase();
    let items = allFiles.filter(f => {
      const kind = fileKind(f.filename);
      const matchesFilter = currentFilter === 'all' || kind === currentFilter;
      const matchesQuery = !q || f.filename.toLowerCase().includes(q);
      return matchesFilter && matchesQuery;
    });
    items = items.slice().sort((a, b) => {
      if(currentSort === 'name') return a.filename.localeCompare(b.filename);
      if(currentSort === 'size') return (b.size_bytes||0) - (a.size_bytes||0);
      if(currentSort === 'expiry') {
        const ra = a.expires_in < 0 ? Infinity : a.expires_in;
        const rb = b.expires_in < 0 ? Infinity : b.expires_in;
        return ra - rb;
      }
      return b.created_at - a.created_at;
    });
    renderFiles(items);
    renderBulkBar();
  }

  function renderSummary() {
    const totalSize = allFiles.reduce((sum, f) => sum + (f.size_bytes || 0), 0);
    const expiringSoon = allFiles.filter(f => f.expires_in >= 0 && f.expires_in < 3600).length;
    let html = `<strong>${allFiles.length}</strong> arquivos &middot; ${formatSize(totalSize)}`;
    if(expiringSoon > 0) html += ` &middot; <span class="summary-warn">${expiringSoon} expira(m) em breve</span>`;
    summaryBar.innerHTML = html;
  }

  function renderFiles(items) {
    if(!items.length) { fileList.innerHTML = '<div class="empty-state">Nenhum arquivo encontrado</div>'; return; }
    fileList.innerHTML = items.map(f => {
      const icon = getFileIcon(f.filename);
      const remaining = formatCountdown(f.expires_in);
      const soon = f.expires_in >= 0 && f.expires_in < 3600;
      const created = new Date(f.created_at * 1000).toLocaleString('pt-BR', {day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'});
      const thumbOrIcon = f.is_image
        ? `<img class="file-thumb" src="${esc(f.url)}" alt="${esc(f.filename)}" loading="lazy">`
        : `<span class="file-icon">${icon}</span>`;
      const openBtn = f.is_image
        ? `<a class="btn-icon" href="${esc(f.view_url)}" target="_blank" title="Visualizar">&#128065; Ver</a>`
        : `<a class="btn-icon" href="${esc(f.url)}" target="_blank" title="Abrir">&#128279;</a>`;
      const isConfirming = confirmingId === f.id;
      const deleteBtn = isConfirming
        ? `<button class="btn-icon danger-confirm" data-action="delete" data-id="${f.id}" title="Confirmar exclusao">Excluir?</button>`
        : `<button class="btn-icon danger" data-action="delete" data-id="${f.id}" title="Excluir">&#128465;</button>`;
      const isRenewing = renewingId === f.id;
      const renewRow = isRenewing ? `
        <div class="renew-row">
          <button class="renew-chip" data-action="renew-apply" data-id="${f.id}" data-ttl="3600">1 hora</button>
          <button class="renew-chip" data-action="renew-apply" data-id="${f.id}" data-ttl="86400">24 horas</button>
          <button class="renew-chip" data-action="renew-apply" data-id="${f.id}" data-ttl="604800">7 dias</button>
          <button class="renew-chip" data-action="renew-apply" data-id="${f.id}" data-ttl="0">Nunca expira</button>
        </div>` : '';
      const views = f.views || 0;
      const downloads = f.downloads || 0;
      return `<div class="file-card">
        <div class="file-lead">
          <input class="select-box" type="checkbox" data-action="select" data-id="${f.id}" ${selectedIds.has(f.id) ? 'checked' : ''}>
          ${thumbOrIcon}
        </div>
        <div class="file-info">
          <div class="file-name" title="${esc(f.filename)}">${esc(f.filename)}</div>
          <div class="file-meta">
            <span class="${soon ? 'soon' : ''}">&#9200; ${remaining}</span>
            <span>&#128197; ${created}</span>
          </div>
          <div class="file-metrics">
            <span class="${views === 0 ? 'zero' : ''}">&#128065; ${views} visualiza${views===1?'cao':'coes'} &middot; ultima: ${formatLast(f.last_viewed_at)}</span>
            <span class="${downloads === 0 ? 'zero' : ''}">&#11015; ${downloads} download${downloads===1?'':'s'} &middot; ultimo: ${formatLast(f.last_downloaded_at)}</span>
          </div>
          ${renewRow}
        </div>
        <div class="file-actions">
          <button class="btn-icon ${isRenewing ? 'active' : ''}" data-action="renew-toggle" data-id="${f.id}" title="Renovar validade">&#128260;</button>
          <button class="btn-icon" data-action="copy" data-url="${esc(f.url)}" title="Copiar link">&#128203;</button>
          ${openBtn}
          ${deleteBtn}
        </div>
      </div>`;
    }).join('');
  }

  function renderBulkBar() {
    if(selectedIds.size > 0) {
      bulkBar.classList.add('active');
      bulkCount.textContent = `${selectedIds.size} selecionado(s)`;
    } else {
      bulkBar.classList.remove('active');
    }
  }

  // --- Event delegation on the file list ---
  fileList.addEventListener('click', async ev => {
    const btn = ev.target.closest('[data-action]');
    if(!btn) return;
    const action = btn.dataset.action;
    const id = btn.dataset.id;

    if(action === 'copy') { copyLink(btn.dataset.url, btn); return; }

    if(action === 'delete') {
      if(confirmingId === id) {
        confirmingId = null;
        const res = await fetch(`/api/files/${id}`, { method: 'DELETE' });
        if(res.ok) { showToast('Arquivo removido'); selectedIds.delete(id); await loadFiles(); }
        else showToast('Erro ao excluir');
      } else {
        confirmingId = id;
        render();
      }
      return;
    }

    if(action === 'renew-toggle') {
      renewingId = renewingId === id ? null : id;
      render();
      return;
    }

    if(action === 'renew-apply') {
      const ttl = parseInt(btn.dataset.ttl, 10);
      renewingId = null;
      const res = await fetch(`/api/files/${id}/ttl`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ttl })
      });
      if(res.ok) { showToast('Validade renovada'); await loadFiles(); }
      else showToast('Erro ao renovar');
      return;
    }
  });

  fileList.addEventListener('change', ev => {
    const el = ev.target.closest('[data-action="select"]');
    if(!el) return;
    const id = el.dataset.id;
    if(el.checked) selectedIds.add(id); else selectedIds.delete(id);
    renderBulkBar();
  });

  // --- Filters / search / sort ---
  searchInput.addEventListener('input', () => { currentQuery = searchInput.value; render(); });
  chipRow.addEventListener('click', ev => {
    const chip = ev.target.closest('.chip');
    if(!chip) return;
    currentFilter = chip.dataset.kind;
    chipRow.querySelectorAll('.chip').forEach(c => c.classList.toggle('active', c === chip));
    render();
  });
  sortSelect.addEventListener('change', () => { currentSort = sortSelect.value; render(); });

  // --- Bulk actions ---
  document.getElementById('bulkCancelBtn').addEventListener('click', () => { selectedIds.clear(); render(); });
  document.getElementById('bulkDeleteBtn').addEventListener('click', async () => {
    const ids = Array.from(selectedIds);
    if(!ids.length) return;
    const responses = await Promise.all(ids.map(id => fetch(`/api/files/${id}`, { method: 'DELETE' }).catch(() => null)));
    let successCount = 0;
    responses.forEach((res, i) => {
      if(res && res.ok) {
        successCount++;
        selectedIds.delete(ids[i]);
      }
    });
    if(successCount === ids.length) {
      showToast(`${ids.length} arquivo(s) excluidos`);
    } else {
      showToast(`${successCount} de ${ids.length} arquivo(s) excluidos`);
    }
    renderBulkBar();
    await loadFiles();
  });
  document.getElementById('bulkRenewBtn').addEventListener('click', async () => {
    const ids = Array.from(selectedIds);
    if(!ids.length) return;
    const responses = await Promise.all(ids.map(id => fetch(`/api/files/${id}/ttl`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ttl: 0 })
    }).catch(() => null)));
    let successCount = 0;
    responses.forEach((res, i) => {
      if(res && res.ok) {
        successCount++;
        selectedIds.delete(ids[i]);
      }
    });
    if(successCount === ids.length) {
      showToast(`${ids.length} arquivo(s) renovados`);
    } else {
      showToast(`${successCount} de ${ids.length} arquivo(s) renovados`);
    }
    renderBulkBar();
    await loadFiles();
  });

  function getFileIcon(name) {
    const ext = (name.split('.').pop() || '').toLowerCase();
    const map = {
      pdf:'&#128196;', doc:'&#128196;', docx:'&#128196;', txt:'&#128196;',
      png:'&#128444;', jpg:'&#128444;', jpeg:'&#128444;', gif:'&#128444;', webp:'&#128444;', svg:'&#128444;',
      mp4:'&#127909;', mov:'&#127909;', avi:'&#127909;', mkv:'&#127909;', webm:'&#127909;',
      mp3:'&#127925;', wav:'&#127925;', flac:'&#127925;', ogg:'&#127925;',
      zip:'&#128230;', rar:'&#128230;', tar:'&#128230;', gz:'&#128230;', '7z':'&#128230;',
      js:'&#128187;', ts:'&#128187;', py:'&#128187;', json:'&#128187;', html:'&#128187;', css:'&#128187;',
    };
    return map[ext] || '&#128193;';
  }

  function formatCountdown(seconds) {
    if(seconds < 0) return 'Nunca expira';
    if(seconds === 0) return 'Expirado';
    if(seconds < 60) return `${seconds}s`;
    if(seconds < 3600) return `${Math.floor(seconds/60)}min`;
    if(seconds < 86400) { const h = Math.floor(seconds/3600); const m = Math.floor((seconds%3600)/60); return `${h}h ${m}min`; }
    const d = Math.floor(seconds/86400); const h = Math.floor((seconds%86400)/3600);
    return `${d}d ${h}h`;
  }

  function formatLast(epoch) {
    if(!epoch) return 'nunca';
    const diff = Math.max(0, Date.now()/1000 - epoch);
    if(diff < 60) return 'ha poucos segundos';
    if(diff < 3600) return `ha ${Math.floor(diff/60)}min`;
    if(diff < 86400) return `ha ${Math.floor(diff/3600)}h`;
    return `ha ${Math.floor(diff/86400)}d`;
  }

  function formatSize(bytes) {
    if(bytes < 1024) return bytes + ' B';
    if(bytes < 1048576) return (bytes/1024).toFixed(1) + ' KB';
    if(bytes < 1073741824) return (bytes/1048576).toFixed(1) + ' MB';
    return (bytes/1073741824).toFixed(2) + ' GB';
  }

  function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML.replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }

  function copyLink(url, btn) {
    navigator.clipboard.writeText(url).then(() => {
      btn.classList.add('copied'); showToast('Link copiado!');
      setTimeout(() => btn.classList.remove('copied'), 2000);
    }).catch(() => {
      const ta = document.createElement('textarea'); ta.value = url; document.body.appendChild(ta);
      ta.select(); document.execCommand('copy'); document.body.removeChild(ta);
      showToast('Link copiado!');
    });
  }

  function showToast(msg) { toast.textContent = msg; toast.classList.add('show'); setTimeout(() => toast.classList.remove('show'), 2000); }

  setInterval(loadFiles, 30000);
  fetch('/api/me').then(r=>r.json()).then(d=>{ if(d.email) document.getElementById('userEmail').textContent = d.email; });
  loadFiles();
})();
</script>
</body>
</html>"""


# ---------------------------------------------------------------------------
# Model
# ---------------------------------------------------------------------------
class FileMetadata:
    """File metadata stored in JSON sidecar"""

    def __init__(
        self,
        file_id: str,
        filename: str,
        ttl: int,
        created_at: float,
        views: int = 0,
        downloads: int = 0,
        last_viewed_at: Optional[float] = None,
        last_downloaded_at: Optional[float] = None,
        size_bytes: int = 0,
    ):
        self.file_id = file_id
        self.filename = filename
        self.ttl = ttl
        self.created_at = created_at
        self.views = views
        self.downloads = downloads
        self.last_viewed_at = last_viewed_at
        self.last_downloaded_at = last_downloaded_at
        self.size_bytes = size_bytes

    @property
    def expires_at(self) -> float:
        return self.created_at + self.ttl

    @property
    def is_expired(self) -> bool:
        if self.ttl == 0:
            return False
        return time.time() > self.expires_at

    @property
    def expires_in(self) -> int:
        if self.ttl == 0:
            return -1  # never expires
        remaining = int(self.expires_at - time.time())
        return max(0, remaining)

    def to_dict(self) -> dict:
        return {
            "file_id": self.file_id,
            "filename": self.filename,
            "ttl": self.ttl,
            "created_at": self.created_at,
            "views": self.views,
            "downloads": self.downloads,
            "last_viewed_at": self.last_viewed_at,
            "last_downloaded_at": self.last_downloaded_at,
            "size_bytes": self.size_bytes,
        }

    @classmethod
    def from_dict(cls, data: dict) -> "FileMetadata":
        return cls(
            file_id=data["file_id"],
            filename=data["filename"],
            ttl=data["ttl"],
            created_at=data["created_at"],
            views=data.get("views", 0),
            downloads=data.get("downloads", 0),
            last_viewed_at=data.get("last_viewed_at", None),
            last_downloaded_at=data.get("last_downloaded_at", None),
            size_bytes=data.get("size_bytes", 0),
        )

    @classmethod
    def from_file(cls, metadata_path: Path) -> Optional["FileMetadata"]:
        """Load metadata from JSON sidecar file"""
        try:
            with open(metadata_path, "r") as f:
                data = json.load(f)
            return cls.from_dict(data)
        except (FileNotFoundError, json.JSONDecodeError):
            return None

    def save(self, metadata_path: Path):
        """Save metadata to JSON sidecar file"""
        with open(metadata_path, "w") as f:
            json.dump(self.to_dict(), f)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def log_event(event: str, **fields):
    """Structured logging helper."""
    print(json.dumps({"svc": "tmpup", "event": event, **fields}))


def validate_ttl(ttl: int) -> int:
    """Validate TTL: 0 means never expires, otherwise between 1 and 31536000 seconds."""
    if isinstance(ttl, bool) or not isinstance(ttl, int):
        raise ValueError("TTL must be a valid integer")
    if ttl < 0 or ttl > 86400 * 365:
        raise ValueError("TTL must be 0 (never expires) or between 1 and 31536000 seconds")
    return ttl


def get_file_paths(file_id: str) -> tuple[Path, Path]:
    """Get paths for file and its metadata"""
    try:
        val = uuid.UUID(str(file_id))
    except (ValueError, TypeError, AttributeError):
        raise ValueError(f"Invalid file ID: {file_id}")
    file_path = DATA_DIR / str(val)
    metadata_path = DATA_DIR / f"{val}.meta.json"
    return file_path, metadata_path


def _file_meta_dict(metadata: FileMetadata) -> dict:
    """Format FileMetadata into a public metadata dictionary."""
    size_bytes = getattr(metadata, "size_bytes", 0) or 0
    if size_bytes <= 0:
        try:
            file_path, _ = get_file_paths(metadata.file_id)
            size_bytes = file_path.stat().st_size
        except (FileNotFoundError, ValueError):
            size_bytes = 0

    return {
        "id": metadata.file_id,
        "filename": metadata.filename,
        "url": f"{BASE_URL}/d/{metadata.file_id}/{metadata.filename}",
        "view_url": f"{BASE_URL}/v/{metadata.file_id}/{metadata.filename}",
        "is_image": is_image_file(metadata.filename),
        "expires_in": metadata.expires_in,
        "created_at": metadata.created_at,
        "size_bytes": size_bytes,
        "views": metadata.views,
        "downloads": metadata.downloads,
        "last_viewed_at": metadata.last_viewed_at,
        "last_downloaded_at": metadata.last_downloaded_at,
    }


def _list_active_files() -> list[dict]:
    """List active (non-expired) files with metadata"""
    files = []
    for metadata_file in DATA_DIR.glob("*.meta.json"):
        metadata = FileMetadata.from_file(metadata_file)
        if metadata and not metadata.is_expired:
            files.append(_file_meta_dict(metadata))
    return sorted(files, key=lambda x: x["created_at"], reverse=True)


def _get_file_info(file_id: str) -> Optional[dict]:
    """Get metadata dict for a single active file, or None if not found/expired."""
    try:
        file_path, metadata_path = get_file_paths(file_id)
    except ValueError:
        return None
    metadata = FileMetadata.from_file(metadata_path)
    if not metadata or metadata.is_expired or not file_path.exists():
        return None
    return _file_meta_dict(metadata)


def delete_file_by_id(file_id: str) -> bool:
    """Remove file and metadata sidecar by file ID. Returns True if deleted, False otherwise."""
    try:
        file_path, metadata_path = get_file_paths(file_id)
    except ValueError:
        log_event("file_delete_failed", file_id=file_id, reason="not_found")
        return False

    if not file_path.exists() and not metadata_path.exists():
        log_event("file_delete_failed", file_id=file_id, reason="not_found")
        return False

    try:
        if file_path.exists():
            file_path.unlink()
        if metadata_path.exists():
            metadata_path.unlink()
    except FileNotFoundError:
        log_event("file_delete_failed", file_id=file_id, reason="not_found")
        return False
    except Exception as e:
        log_event("file_delete_failed", file_id=file_id, error=str(e))
        raise

    log_event("file_deleted", file_id=file_id)
    return True


def extend_file_ttl(file_id: str, ttl: int) -> Optional[dict]:
    """Reload metadata, validate TTL, set created_at=time.time() and ttl=new value, save, return updated dict or None."""
    try:
        valid_ttl = validate_ttl(ttl)
    except ValueError as e:
        log_event("extend_ttl_failed", file_id=file_id, ttl=ttl, error=str(e))
        raise

    try:
        file_path, metadata_path = get_file_paths(file_id)
    except ValueError:
        log_event("extend_ttl_failed", file_id=file_id, reason="not_found")
        return None

    try:
        with _metadata_lock:
            metadata = FileMetadata.from_file(metadata_path)
            if not metadata or metadata.is_expired or not file_path.exists():
                log_event("extend_ttl_failed", file_id=file_id, reason="not_found")
                return None
            metadata.created_at = time.time()
            metadata.ttl = valid_ttl
            metadata.save(metadata_path)
        log_event("extend_ttl_success", file_id=file_id, ttl=valid_ttl)
        return _get_file_info(file_id)
    except Exception as e:
        log_event("extend_ttl_failed", file_id=file_id, error=str(e))
        raise


def cleanup_expired_files():
    """Remove expired files and their metadata"""
    cleaned = 0
    for metadata_file in DATA_DIR.glob("*.meta.json"):
        metadata = FileMetadata.from_file(metadata_file)
        if metadata and metadata.is_expired:
            file_id = metadata.file_id
            try:
                file_path, metadata_path = get_file_paths(file_id)
            except ValueError:
                continue

            # Delete file and metadata
            try:
                if file_path.exists():
                    file_path.unlink()
                if metadata_path.exists():
                    metadata_path.unlink()
                cleaned += 1
            except Exception as e:
                print(f"Error cleaning up {file_id}: {e}")

    if cleaned > 0:
        print(f"Cleaned up {cleaned} expired file(s)")


async def cleanup_task():
    """Background task to cleanup expired files"""
    while True:
        await asyncio.sleep(CLEANUP_INTERVAL)
        cleanup_expired_files()


# ---------------------------------------------------------------------------
# MCP Server
# ---------------------------------------------------------------------------
mcp = MCPServer("TmpUp")
mcp_exit_stack = AsyncExitStack()


# ---------------------------------------------------------------------------
# Startup / Shutdown
# ---------------------------------------------------------------------------
@app.on_event("startup")
async def startup_event():
    """Start background cleanup task and migrate existing files to infinite TTL"""
    await mcp_exit_stack.enter_async_context(mcp.session_manager.run())
    # One-time migration: set all existing files to never expire
    migrated = 0
    for metadata_file in DATA_DIR.glob("*.meta.json"):
        metadata = FileMetadata.from_file(metadata_file)
        if metadata and metadata.ttl != 0:
            metadata.ttl = 0
            metadata.save(metadata_file)
            migrated += 1
    if migrated > 0:
        print(f"Migrated {migrated} file(s) to infinite TTL")

    asyncio.create_task(cleanup_task())
    print(f"TmpUp started - data directory: {DATA_DIR}")
    print(f"Auto-cleanup every {CLEANUP_INTERVAL} seconds")


@app.on_event("shutdown")
async def shutdown_event():
    await mcp_exit_stack.aclose()



# ---------------------------------------------------------------------------
# Auth routes
# ---------------------------------------------------------------------------
LOGIN_HTML = """<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>TmpUp - Login</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:system-ui,-apple-system,sans-serif;background:#0f0f0f;color:#e5e5e5;
    min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}
  .card{background:#1a1a1a;border:1px solid #262626;border-radius:16px;
    padding:40px 32px;text-align:center;max-width:360px;width:100%}
  h1{font-size:1.6rem;font-weight:700;color:#fff;margin-bottom:6px}
  .subtitle{color:#737373;font-size:.9rem;margin-bottom:32px}
  .btn-google{display:flex;align-items:center;justify-content:center;gap:10px;
    background:#fff;color:#1f1f1f;border:none;border-radius:8px;padding:12px 24px;
    font-size:.95rem;font-weight:500;cursor:pointer;text-decoration:none;
    transition:background .15s;width:100%}
  .btn-google:hover{background:#f1f1f1}
  .note{margin-top:20px;color:#525252;font-size:.8rem}
</style>
</head>
<body>
<div class="card">
  <h1>TmpUp</h1>
  <p class="subtitle">Upload temporario de arquivos</p>
  <a href="/auth/google" class="btn-google">
    <svg width="18" height="18" viewBox="0 0 18 18">
      <path fill="#4285F4" d="M16.51 8H8.98v3h4.3c-.18 1-.74 1.48-1.6 2.04v2.01h2.6a7.8 7.8 0 0 0 2.38-5.88c0-.57-.05-.66-.15-1.18z"/>
      <path fill="#34A353" d="M8.98 17c2.16 0 3.97-.72 5.3-1.94l-2.6-2a4.8 4.8 0 0 1-7.18-2.54H1.83v2.07A8 8 0 0 0 8.98 17z"/>
      <path fill="#FBBC05" d="M4.5 10.52a4.8 4.8 0 0 1 0-3.04V5.41H1.83a8 8 0 0 0 0 7.18l2.67-2.07z"/>
      <path fill="#EA4335" d="M8.98 4.18c1.17 0 2.23.4 3.06 1.2l2.3-2.3A8 8 0 0 0 1.83 5.4L4.5 7.49a4.77 4.77 0 0 1 4.48-3.31z"/>
    </svg>
    Entrar com Google
  </a>
  <p class="note">Acesso restrito a @douravita.com.br</p>
</div>
</body>
</html>"""


@app.get("/auth/login", response_class=HTMLResponse)
async def auth_login():
    return HTMLResponse(content=LOGIN_HTML)


@app.get("/auth/google")
async def auth_google():
    params = urlencode({
        "client_id": GOOGLE_CLIENT_ID,
        "redirect_uri": f"{BASE_URL}/auth/callback",
        "response_type": "code",
        "scope": "openid email",
        "prompt": "select_account",
    })
    return RedirectResponse(f"https://accounts.google.com/o/oauth2/v2/auth?{params}", status_code=302)


@app.get("/auth/callback")
async def auth_callback(request: Request, code: str = ""):
    if not code:
        raise HTTPException(status_code=400, detail="Codigo OAuth ausente")

    async with httpx.AsyncClient() as client:
        token_resp = await client.post("https://oauth2.googleapis.com/token", data={
            "code": code,
            "client_id": GOOGLE_CLIENT_ID,
            "client_secret": GOOGLE_CLIENT_SECRET,
            "redirect_uri": f"{BASE_URL}/auth/callback",
            "grant_type": "authorization_code",
        })
        token_data = token_resp.json()

        if "access_token" not in token_data:
            raise HTTPException(status_code=401, detail="Falha na autenticacao Google")

        userinfo_resp = await client.get(
            "https://www.googleapis.com/oauth2/v3/userinfo",
            headers={"Authorization": f"Bearer {token_data['access_token']}"},
        )
        userinfo = userinfo_resp.json()

    email = userinfo.get("email", "")
    if not email.endswith(f"@{ALLOWED_DOMAIN}"):
        raise HTTPException(status_code=403, detail=f"Acesso restrito a @{ALLOWED_DOMAIN}")

    response = RedirectResponse("/", status_code=302)
    response.set_cookie(
        "session",
        create_session(email),
        max_age=SESSION_MAX_AGE,
        httponly=True,
        secure=True,
        samesite="lax",
    )
    return response


@app.get("/auth/logout")
async def auth_logout():
    response = RedirectResponse("/auth/login", status_code=302)
    response.delete_cookie("session")
    return response


@app.get("/api/me")
async def get_me(request: Request):
    email = verify_session(request.cookies.get("session", ""))
    return {"email": email}


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------
@app.get("/health")
async def health_check():
    """Health check endpoint"""
    return {"status": "ok"}


@app.get("/api/files")
async def api_list_files():
    """List active (non-expired) files with metadata"""
    return await run_in_threadpool(_list_active_files)


@app.get("/api/files/{file_id}")
async def get_file(file_id: str):
    """Get metadata for a specific active file"""
    info = await run_in_threadpool(_get_file_info, file_id)
    if not info:
        raise HTTPException(status_code=404, detail="File not found")
    return info


@app.delete("/api/files/{file_id}")
async def delete_file_endpoint(file_id: str):
    """Delete a file and its metadata"""
    deleted = await run_in_threadpool(delete_file_by_id, file_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="File not found")
    return {"deleted": True}


@app.patch("/api/files/{file_id}/ttl")
async def patch_file_ttl(file_id: str, request: Request):
    """Extend or update TTL for an existing file"""
    try:
        body = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid JSON body")

    if not isinstance(body, dict) or "ttl" not in body:
        raise HTTPException(status_code=400, detail="'ttl' field is required")

    try:
        valid_ttl = validate_ttl(body["ttl"])
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    updated = await run_in_threadpool(extend_file_ttl, file_id, valid_ttl)
    if updated is None:
        raise HTTPException(status_code=404, detail="File not found")
    return updated




@app.post("/api/upload")
async def api_upload_file(request: Request):
    """
    Upload a file with automatic expiration

    Headers:
    - X-Filename: Original filename (required)
    - X-TTL: Time to live in seconds (default: 3600)

    Body: Raw file bytes

    Returns: {"url": "...", "id": "...", "expires_in": ...}
    """
    # Get headers (filename is URL-encoded to support non-ASCII chars)
    raw_filename = request.headers.get("X-Filename")
    if not raw_filename:
        raise HTTPException(status_code=400, detail="X-Filename header required")
    filename = unquote(raw_filename)

    try:
        ttl = int(request.headers.get("X-TTL", "3600"))
    except ValueError:
        raise HTTPException(status_code=400, detail="X-TTL must be a valid integer")

    # Validate TTL (0 = never expires)
    try:
        ttl = validate_ttl(ttl)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    # Generate unique file ID
    file_id = str(uuid.uuid4())
    file_path, metadata_path = get_file_paths(file_id)

    # Stream file to disk (supports large files without loading into RAM)
    try:
        total_written = 0
        with open(file_path, "wb") as f:
            async for chunk in request.stream():
                f.write(chunk)
                total_written += len(chunk)

        if total_written == 0:
            if file_path.exists():
                file_path.unlink()
            raise HTTPException(status_code=400, detail="Empty file")

        # Save metadata
        metadata = FileMetadata(
            file_id=file_id,
            filename=filename,
            ttl=ttl,
            created_at=time.time(),
            size_bytes=total_written,
        )
        metadata.save(metadata_path)

        # Return response matching the exact contract
        return {
            "url": f"{BASE_URL}/d/{file_id}/{filename}",
            "id": file_id,
            "expires_in": ttl
        }

    except Exception as e:
        # Cleanup on error
        if file_path.exists():
            file_path.unlink()
        if metadata_path.exists():
            metadata_path.unlink()
        raise HTTPException(status_code=500, detail=f"Upload failed: {str(e)}")


def _download_file(file_id: str, filename: str = "", dl: Optional[str] = None) -> FileResponse:
    """Synchronous file download logic executed in a threadpool worker."""
    try:
        file_path, metadata_path = get_file_paths(file_id)
    except ValueError:
        raise HTTPException(status_code=404, detail="File not found")

    # Load metadata
    metadata = FileMetadata.from_file(metadata_path)
    if not metadata:
        raise HTTPException(status_code=404, detail="File not found")

    # Check if expired
    if metadata.is_expired:
        # Cleanup expired file
        if file_path.exists():
            try:
                file_path.unlink()
            except FileNotFoundError:
                pass
        if metadata_path.exists():
            try:
                metadata_path.unlink()
            except FileNotFoundError:
                pass
        raise HTTPException(status_code=404, detail="File expired")

    # Verify file exists
    if not file_path.exists():
        raise HTTPException(status_code=404, detail="File not found")

    # Guess content type using real metadata.filename
    content_type, _ = mimetypes.guess_type(metadata.filename)
    if not content_type:
        content_type = "application/octet-stream"

    # Inline for images/viewable types, attachment for the rest
    inline_types = {"image/", "video/", "audio/", "text/", "application/pdf"}
    is_inline = any(content_type.startswith(t) for t in inline_types)
    force_download = bool(dl and dl.lower() not in ("0", "false", "no"))

    now = time.time()
    if is_inline and not force_download:
        headers = {"Content-Disposition": "inline"}
    else:
        encoded_filename = urlquote(metadata.filename, safe="")
        headers = {"Content-Disposition": f"attachment; filename*=UTF-8''{encoded_filename}"}

    with _metadata_lock:
        # Re-read under the lock so this increment is based on the latest
        # saved state, not the copy read before the lock was acquired.
        fresh = FileMetadata.from_file(metadata_path) or metadata
        if is_inline and not force_download:
            fresh.views += 1
            fresh.last_viewed_at = now
        else:
            fresh.downloads += 1
            fresh.last_downloaded_at = now
        fresh.save(metadata_path)

    return FileResponse(
        path=file_path,
        media_type=content_type,
        headers=headers
    )


@app.get("/d/{file_id}/{filename}")
async def download_file(file_id: str, filename: str, dl: Optional[str] = None):
    """
    Download a file by ID and filename

    Returns 404 if file not found or expired
    """
    return await run_in_threadpool(_download_file, file_id, filename, dl)


VIEWER_TEMPLATE = """<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>{filename} - TmpUp</title>
<style>
  *,*::before,*::after{{box-sizing:border-box;margin:0;padding:0}}
  body{{
    font-family:system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
    background:#0f0f0f;color:#e5e5e5;min-height:100vh;
    display:flex;flex-direction:column;align-items:center;justify-content:center;
    padding:24px 16px;gap:20px;
  }}
  a{{color:#3b82f6}}
  a:hover{{color:#60a5fa}}
  .viewer-img{{max-width:100%;max-height:80vh;border-radius:12px;box-shadow:0 8px 32px rgba(0,0,0,.6);display:block}}
  .viewer-meta{{text-align:center;display:flex;flex-direction:column;align-items:center;gap:8px}}
  .viewer-filename{{font-size:1rem;font-weight:600;color:#e5e5e5;word-break:break-all;max-width:640px}}
  .viewer-expiry{{font-size:.8rem;color:#737373}}
  .viewer-metrics{{font-size:.75rem;color:#525252;display:flex;gap:14px;flex-wrap:wrap;justify-content:center}}
  .viewer-error{{font-size:.85rem;color:#ef4444;text-align:center;display:none}}
  .viewer-actions{{display:flex;gap:10px;flex-wrap:wrap;justify-content:center}}
  .btn{{background:#262626;border:1px solid #333;border-radius:8px;padding:10px 18px;cursor:pointer;font-size:.85rem;color:#e5e5e5;text-decoration:none;display:inline-flex;align-items:center;gap:6px;transition:all .15s}}
  .btn:hover{{background:#333;border-color:#444}}
  .btn-primary{{background:#3b82f6;border-color:#3b82f6;color:#fff}}
  .btn-primary:hover{{background:#2563eb;border-color:#2563eb}}
  .btn-danger{{color:#fca5a5;border-color:#333}}
  .btn-danger:hover{{background:rgba(239,68,68,.12);border-color:#ef4444}}
  .btn-danger.confirm{{background:#7f1d1d;border-color:#ef4444;color:#fecaca}}
  .deleted-card{{background:#1a1a1a;border:1px solid #262626;border-radius:16px;padding:40px 32px;text-align:center;max-width:340px;display:none;flex-direction:column;align-items:center;gap:14px}}
  .deleted-card.active{{display:flex}}
  .deleted-title{{font-size:1.05rem;font-weight:600;color:#fff}}
  .deleted-sub{{font-size:.85rem;color:#737373}}
</style>
</head>
<body>

<div id="viewerContent">
  <img class="viewer-img" src="{image_url}" alt="{filename}">
  <div class="viewer-meta">
    <div class="viewer-filename">{filename}</div>
    <div class="viewer-expiry">{expiry_text}</div>
  </div>
  <div class="viewer-metrics" id="viewerMetrics"></div>
  <div class="viewer-error" id="viewerError"></div>
  <div class="viewer-actions">
    <a class="btn btn-primary" href="{download_url}" download="{filename}">&#11015; Download</a>
    <button class="btn" id="copyBtn">&#128203; Copiar URL da imagem</button>
    <button class="btn btn-danger" id="deleteBtn">&#128465; Excluir</button>
  </div>
</div>

<div class="deleted-card" id="deletedCard">
  <div class="deleted-title">Arquivo excluido</div>
  <div class="deleted-sub">Este link nao estara mais disponivel.</div>
  <a class="btn btn-primary" href="/">Voltar para o TmpUp</a>
</div>

<script>
(function(){{
  const fileId = {file_id_json};
  const imageUrlAbs = {image_url_abs_json};
  const copyBtn = document.getElementById('copyBtn');
  const deleteBtn = document.getElementById('deleteBtn');
  const metricsEl = document.getElementById('viewerMetrics');
  const errorEl = document.getElementById('viewerError');
  let confirming = false;

  copyBtn.addEventListener('click', () => {{
    navigator.clipboard.writeText(imageUrlAbs).then(() => {{
      copyBtn.textContent = '✓ Copiado!';
      setTimeout(() => copyBtn.innerHTML = '&#128203; Copiar URL da imagem', 2000);
    }});
  }});

  deleteBtn.addEventListener('click', async () => {{
    if(!confirming) {{
      confirming = true;
      deleteBtn.classList.add('confirm');
      deleteBtn.textContent = 'Confirmar exclusao?';
      return;
    }}
    try {{
      const res = await fetch(`/api/files/${{fileId}}`, {{ method: 'DELETE' }});
      if(res.ok) {{
        document.getElementById('viewerContent').style.display = 'none';
        document.getElementById('deletedCard').classList.add('active');
      }} else {{
        confirming = false;
        deleteBtn.classList.remove('confirm');
        deleteBtn.innerHTML = '&#128465; Excluir';
        if(errorEl) {{
          errorEl.textContent = 'Erro ao excluir arquivo';
          errorEl.style.display = 'block';
        }}
      }}
    }} catch(err) {{
      confirming = false;
      deleteBtn.classList.remove('confirm');
      deleteBtn.innerHTML = '&#128465; Excluir';
      if(errorEl) {{
        errorEl.textContent = 'Erro ao excluir arquivo';
        errorEl.style.display = 'block';
      }}
    }}
  }});

  fetch(`/api/files/${{fileId}}`).then(r => r.ok ? r.json() : null).then(info => {{
    if(!info) return;
    const views = info.views || 0;
    const downloads = info.downloads || 0;
    metricsEl.innerHTML = `<span>&#128065; ${{views}} visualizacoes</span><span>&#11015; ${{downloads}} downloads</span>`;
  }});
}})();
</script>
</body>
</html>"""


IMAGE_EXTENSIONS = {"png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico", "tiff", "avif"}


def is_image_file(filename: str) -> bool:
    ext = filename.rsplit(".", 1)[-1].lower() if "." in filename else ""
    return ext in IMAGE_EXTENSIONS


def format_expiry(expires_in: int) -> str:
    if expires_in <= 0:
        return "Nunca expira"
    if expires_in < 3600:
        return f"Expira em {expires_in // 60}min"
    if expires_in < 86400:
        h = expires_in // 3600
        m = (expires_in % 3600) // 60
        return f"Expira em {h}h {m}min"
    return f"Expira em {expires_in // 86400} dia(s)"


def _view_file(file_id: str, filename: str = "") -> Response:
    """Synchronous viewer page logic executed in a threadpool worker."""
    try:
        file_path, metadata_path = get_file_paths(file_id)
    except ValueError:
        raise HTTPException(status_code=404, detail="File not found")

    metadata = FileMetadata.from_file(metadata_path)
    if not metadata:
        raise HTTPException(status_code=404, detail="File not found")

    if metadata.is_expired:
        if file_path.exists():
            try:
                file_path.unlink()
            except FileNotFoundError:
                pass
        if metadata_path.exists():
            try:
                metadata_path.unlink()
            except FileNotFoundError:
                pass
        raise HTTPException(status_code=404, detail="File expired")

    if not file_path.exists():
        raise HTTPException(status_code=404, detail="File not found")

    # For non-images, redirect to raw download using real metadata.filename
    if not is_image_file(metadata.filename):
        return RedirectResponse(f"/d/{file_id}/{metadata.filename}")

    safe_filename = html.escape(metadata.filename)
    image_url = html.escape(f"/d/{file_id}/{metadata.filename}", quote=True)
    download_url = html.escape(f"/d/{file_id}/{metadata.filename}?dl=1", quote=True)
    image_url_abs = f"{BASE_URL}/d/{file_id}/{metadata.filename}"

    return HTMLResponse(VIEWER_TEMPLATE.format(
        filename=safe_filename,
        image_url=image_url,
        download_url=download_url,
        image_url_abs_json=json.dumps(image_url_abs).replace("</", "<\\/"),
        file_id_json=json.dumps(file_id).replace("</", "<\\/"),
        expiry_text=format_expiry(metadata.expires_in),
    ))


@app.get("/v/{file_id}/{filename}", response_class=HTMLResponse)
async def view_file(file_id: str, filename: str):
    """Viewer page for images"""
    return await run_in_threadpool(_view_file, file_id, filename)


@app.post("/admin/set-all-infinite")
async def set_all_infinite():
    """Set TTL=0 (never expires) for all existing files"""
    updated = 0
    for metadata_file in DATA_DIR.glob("*.meta.json"):
        metadata = FileMetadata.from_file(metadata_file)
        if metadata and metadata.ttl != 0:
            metadata.ttl = 0
            metadata.save(metadata_file)
            updated += 1
    return {"updated": updated}


@app.get("/", response_class=HTMLResponse)
async def root():
    """Serve the upload frontend"""
    return HTMLResponse(content=HTML_TEMPLATE)


# ---------------------------------------------------------------------------
# MCP Tools & App Mount
# ---------------------------------------------------------------------------
@mcp.tool()
def upload_file(filename: str, content_base64: str, ttl: int = 0) -> dict:
    """Upload a file encoded in base64 with TTL in seconds (0 = never expires)."""
    try:
        valid_ttl = validate_ttl(ttl)
    except ValueError as e:
        log_event("mcp_upload_failed", filename=filename, ttl=ttl, error=str(e))
        raise

    # Reject payloads whose decoded size would exceed MAX_MCP_UPLOAD_SIZE (200MB)
    pad = 2 if content_base64.endswith("==") else (1 if content_base64.endswith("=") else 0)
    estimated_size = (len(content_base64) * 3 // 4) - pad
    if estimated_size > MAX_MCP_UPLOAD_SIZE:
        log_event("mcp_upload_failed", filename=filename, error=f"File exceeds maximum allowed size ({MAX_MCP_UPLOAD_SIZE // (1024 * 1024)}MB)")
        raise ValueError(f"File exceeds maximum allowed size ({MAX_MCP_UPLOAD_SIZE // (1024 * 1024)}MB)")

    try:
        content = base64.b64decode(content_base64, validate=True)
    except Exception as e:
        log_event("mcp_upload_failed", filename=filename, error=f"Invalid base64: {e}")
        raise ValueError(f"Invalid base64: {e}") from e

    if len(content) == 0:
        log_event("mcp_upload_failed", filename=filename, error="Empty file")
        raise ValueError("Empty file")

    if len(content) > MAX_MCP_UPLOAD_SIZE:
        log_event("mcp_upload_failed", filename=filename, error=f"File exceeds maximum allowed size ({MAX_MCP_UPLOAD_SIZE // (1024 * 1024)}MB)")
        raise ValueError(f"File exceeds maximum allowed size ({MAX_MCP_UPLOAD_SIZE // (1024 * 1024)}MB)")

    file_id = str(uuid.uuid4())
    file_path, metadata_path = get_file_paths(file_id)

    try:
        with open(file_path, "wb") as f:
            f.write(content)

        metadata = FileMetadata(
            file_id=file_id,
            filename=filename,
            ttl=valid_ttl,
            created_at=time.time(),
            size_bytes=len(content),
        )
        metadata.save(metadata_path)

        log_event("mcp_upload_success", file_id=file_id, filename=filename, size=len(content), ttl=valid_ttl)
        return {
            "url": f"{BASE_URL}/d/{file_id}/{filename}",
            "id": file_id,
            "expires_in": valid_ttl,
        }
    except Exception as e:
        if file_path.exists():
            file_path.unlink()
        if metadata_path.exists():
            metadata_path.unlink()
        log_event("mcp_upload_failed", filename=filename, error=str(e))
        raise


@mcp.tool()
def list_files() -> list[dict]:
    """List active (non-expired) files with metadata."""
    return _list_active_files()


@mcp.tool()
def get_file_info(file_id: str) -> dict:
    """Get metadata for a specific active file."""
    info = _get_file_info(file_id)
    if not info:
        raise ValueError(f"File not found: {file_id}")
    return info


@mcp.tool()
def extend_ttl(file_id: str, ttl: int) -> dict:
    """Extend or update TTL for an existing file."""
    info = extend_file_ttl(file_id, ttl)
    if not info:
        raise ValueError(f"File not found: {file_id}")
    return info


@mcp.tool()
def delete_file(file_id: str) -> dict:
    """Delete a file by ID."""
    deleted = delete_file_by_id(file_id)
    return {"deleted": deleted}


app.mount("/mcp", mcp.streamable_http_app(streamable_http_path="/"))


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8844"))
    uvicorn.run(app, host="0.0.0.0", port=port)
