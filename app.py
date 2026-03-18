"""
Temporary File Upload Service
Lightweight service for temporary file storage with auto-expiration
"""
import asyncio
import json
import mimetypes
import os
import time
import uuid
from pathlib import Path
from typing import Optional
from urllib.parse import unquote

from fastapi import FastAPI, Request, Response, HTTPException
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse
import uvicorn

BASE_URL = os.environ.get("BASE_URL", "https://tmpup.douravita.com.br")

app = FastAPI(title="TmpUp", description="Temporary File Upload Service")

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
  h1{font-size:1.8rem;font-weight:700;margin-bottom:4px;color:#fff}
  .subtitle{color:#737373;font-size:.9rem;margin-bottom:32px}
  .container{width:100%;max-width:640px}

  /* Drop zone */
  .dropzone{
    border:2px dashed #333;border-radius:16px;padding:48px 24px;
    text-align:center;cursor:pointer;transition:all .2s;
    background:#1a1a1a;position:relative;
  }
  .dropzone.dragover{border-color:#3b82f6;background:#1a1a2e}
  .dropzone:hover{border-color:#555}
  .dropzone-icon{font-size:3rem;margin-bottom:12px;display:block}
  .dropzone-text{color:#a3a3a3;font-size:.95rem;line-height:1.6}
  .dropzone-text strong{color:#e5e5e5}
  .dropzone input[type=file]{
    position:absolute;inset:0;opacity:0;cursor:pointer;
  }

  /* TTL selector */
  .controls{
    display:flex;gap:12px;margin-top:16px;align-items:center;
    flex-wrap:wrap;justify-content:center;
  }
  .controls label{color:#a3a3a3;font-size:.85rem}
  .controls select{
    background:#262626;color:#e5e5e5;border:1px solid #333;
    border-radius:8px;padding:8px 12px;font-size:.85rem;
    cursor:pointer;outline:none;
  }
  .controls select:focus{border-color:#3b82f6}
  .btn-upload{
    background:#3b82f6;color:#fff;border:none;border-radius:8px;
    padding:10px 24px;font-size:.9rem;font-weight:600;cursor:pointer;
    transition:background .15s;
  }
  .btn-upload:hover{background:#2563eb}
  .btn-upload:disabled{opacity:.5;cursor:not-allowed}

  /* Progress */
  .progress-wrap{
    margin-top:16px;display:none;
  }
  .progress-wrap.active{display:block}
  .progress-bar-bg{
    width:100%;height:8px;background:#262626;border-radius:4px;overflow:hidden;
  }
  .progress-bar{
    height:100%;width:0;background:linear-gradient(90deg,#3b82f6,#60a5fa);
    border-radius:4px;transition:width .2s;
  }
  .progress-text{
    text-align:center;color:#a3a3a3;font-size:.8rem;margin-top:6px;
  }

  /* Status message */
  .status{
    margin-top:12px;text-align:center;font-size:.85rem;min-height:20px;
  }
  .status.error{color:#ef4444}
  .status.success{color:#22c55e}

  /* File list */
  .file-list{margin-top:32px}
  .file-list h2{font-size:1.1rem;color:#fff;margin-bottom:12px;display:flex;align-items:center;gap:8px}
  .file-card{
    background:#1a1a1a;border:1px solid #262626;border-radius:12px;
    padding:14px 16px;margin-bottom:10px;
    display:flex;align-items:center;gap:12px;
    transition:border-color .15s;
  }
  .file-card:hover{border-color:#333}
  .file-icon{font-size:1.5rem;flex-shrink:0}
  .file-info{flex:1;min-width:0}
  .file-name{
    font-size:.9rem;font-weight:500;color:#e5e5e5;
    white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
  }
  .file-meta{font-size:.75rem;color:#737373;margin-top:2px;display:flex;gap:12px;flex-wrap:wrap}
  .file-actions{display:flex;gap:6px;flex-shrink:0}
  .btn-icon{
    background:#262626;border:1px solid #333;border-radius:8px;
    padding:8px 10px;cursor:pointer;font-size:.85rem;color:#e5e5e5;
    transition:all .15s;text-decoration:none;display:inline-flex;align-items:center;gap:4px;
  }
  .btn-icon:hover{background:#333;border-color:#444}
  .btn-icon.copied{background:#166534;border-color:#22c55e;color:#22c55e}

  /* Empty state */
  .empty-state{
    text-align:center;color:#525252;padding:32px;font-size:.9rem;
  }


  /* Responsive */
  @media(max-width:480px){
    .dropzone{padding:32px 16px}
    .dropzone-icon{font-size:2.4rem}
    .file-card{flex-direction:column;align-items:flex-start;gap:8px}
    .file-actions{width:100%;justify-content:flex-end}
  }

  /* Toast */
  .toast{
    position:fixed;bottom:24px;left:50%;transform:translateX(-50%);
    background:#166534;color:#22c55e;padding:10px 20px;border-radius:8px;
    font-size:.85rem;opacity:0;transition:opacity .3s;pointer-events:none;
    border:1px solid #22c55e;z-index:999;
  }
  .toast.show{opacity:1}
</style>
</head>
<body>

<h1>TmpUp</h1>
<p class="subtitle">Upload temporario de arquivos</p>

<div class="container">
  <!-- Drop Zone -->
  <div class="dropzone" id="dropzone">
    <input type="file" id="fileInput" multiple>
    <span class="dropzone-icon">&#128193;</span>
    <div class="dropzone-text">
      <strong>Arraste arquivos aqui</strong><br>
      ou clique para selecionar
    </div>
  </div>

  <!-- Controls -->
  <div class="controls">
    <label for="ttlSelect">&#9200; Expira em:</label>
    <select id="ttlSelect">
      <option value="3600">1 hora</option>
      <option value="21600">6 horas</option>
      <option value="86400" selected>24 horas</option>
      <option value="259200">3 dias</option>
      <option value="604800">7 dias</option>
    </select>
    <button class="btn-upload" id="btnUpload" disabled>Enviar</button>
  </div>

  <!-- Progress -->
  <div class="progress-wrap" id="progressWrap">
    <div class="progress-bar-bg"><div class="progress-bar" id="progressBar"></div></div>
    <div class="progress-text" id="progressText">Enviando...</div>
  </div>

  <!-- Status -->
  <div class="status" id="status"></div>

  <!-- File list -->
  <div class="file-list" id="fileListSection">
    <h2>&#128196; Arquivos enviados</h2>
    <div id="fileList"></div>
  </div>
</div>

<!-- Toast -->
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

  let selectedFiles = [];

  // --- Drag & Drop ---
  ['dragenter','dragover'].forEach(e => {
    dropzone.addEventListener(e, ev => { ev.preventDefault(); dropzone.classList.add('dragover'); });
  });
  ['dragleave','drop'].forEach(e => {
    dropzone.addEventListener(e, ev => { ev.preventDefault(); dropzone.classList.remove('dragover'); });
  });
  dropzone.addEventListener('drop', ev => {
    const files = Array.from(ev.dataTransfer.files);
    if(files.length) { setFiles(files); }
  });
  fileInput.addEventListener('change', () => {
    const files = Array.from(fileInput.files);
    if(files.length) setFiles(files);
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

  // --- Upload ---
  btnUpload.addEventListener('click', async () => {
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
  });

  async function uploadOne(file, ttl, total, idx) {
    progressWrap.classList.add('active');
    progressBar.style.width = '0%';
    const prefix = total > 1 ? `[${idx}/${total}] ` : '';
    progressText.textContent = `${prefix}Enviando ${file.name}...`;
    statusEl.className = 'status';
    statusEl.textContent = '';

    try {
      // Use XMLHttpRequest for progress tracking
      const result = await new Promise((resolve, reject) => {
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
          if(xhr.status >= 200 && xhr.status < 300) {
            resolve(JSON.parse(xhr.responseText));
          } else {
            let msg = 'Upload failed';
            try { msg = JSON.parse(xhr.responseText).detail || msg; } catch(e){}
            reject(new Error(msg));
          }
        });
        xhr.addEventListener('error', () => reject(new Error('Erro de rede')));
        xhr.send(file);
      });

      progressBar.style.width = '100%';
      progressText.textContent = `${prefix}Concluido!`;
      statusEl.className = 'status success';
      statusEl.textContent = `${file.name} enviado com sucesso!`;

      // Save to localStorage
      saveToHistory(result);

      setTimeout(() => {
        progressWrap.classList.remove('active');
      }, 1500);

    } catch(err) {
      progressWrap.classList.remove('active');
      statusEl.className = 'status error';
      statusEl.textContent = `Erro: ${err.message}`;
    }
  }

  // --- History (localStorage) ---
  function getHistory() {
    try { return JSON.parse(localStorage.getItem('tmpup_files') || '[]'); }
    catch { return []; }
  }
  function saveToHistory(result) {
    const history = getHistory();
    history.unshift({
      id: result.id,
      url: result.url,
      expires_in: result.expires_in,
      uploaded_at: Date.now()
    });
    // Keep last 50
    localStorage.setItem('tmpup_files', JSON.stringify(history.slice(0, 50)));
  }

  // --- File list (from API) ---
  async function loadFiles() {
    try {
      const res = await fetch('/api/files');
      const files = await res.json();
      renderFiles(files);
    } catch(e) {
      fileList.innerHTML = '<div class="empty-state">Erro ao carregar arquivos</div>';
    }
  }

  function renderFiles(files) {
    if(!files.length) {
      fileList.innerHTML = '<div class="empty-state">Nenhum arquivo ativo</div>';
      return;
    }
    fileList.innerHTML = files.map(f => {
      const ext = f.filename.split('.').pop().toUpperCase();
      const icon = getFileIcon(f.filename);
      const remaining = formatCountdown(f.expires_in);
      const created = new Date(f.created_at * 1000).toLocaleString('pt-BR', {
        day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'
      });
      return `<div class="file-card">
        <span class="file-icon">${icon}</span>
        <div class="file-info">
          <div class="file-name" title="${esc(f.filename)}">${esc(f.filename)}</div>
          <div class="file-meta">
            <span>&#9200; ${remaining}</span>
            <span>&#128197; ${created}</span>
          </div>
        </div>
        <div class="file-actions">
          <button class="btn-icon" onclick="copyLink('${esc(f.url)}', this)" title="Copiar link">&#128203; Copiar</button>
          <a class="btn-icon" href="${esc(f.url)}" target="_blank" title="Abrir">&#128279;</a>
        </div>
      </div>`;
    }).join('');
  }

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
    if(seconds <= 0) return 'Expirado';
    if(seconds < 60) return `${seconds}s`;
    if(seconds < 3600) return `${Math.floor(seconds/60)}min`;
    if(seconds < 86400) {
      const h = Math.floor(seconds/3600);
      const m = Math.floor((seconds%3600)/60);
      return `${h}h ${m}min`;
    }
    const d = Math.floor(seconds/86400);
    const h = Math.floor((seconds%86400)/3600);
    return `${d}d ${h}h`;
  }

  function formatSize(bytes) {
    if(bytes < 1024) return bytes + ' B';
    if(bytes < 1048576) return (bytes/1024).toFixed(1) + ' KB';
    if(bytes < 1073741824) return (bytes/1048576).toFixed(1) + ' MB';
    return (bytes/1073741824).toFixed(2) + ' GB';
  }

  function esc(s) {
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // --- Copy link ---
  window.copyLink = function(url, btn) {
    navigator.clipboard.writeText(url).then(() => {
      btn.classList.add('copied');
      btn.innerHTML = '&#9989; Copiado';
      showToast('Link copiado!');
      setTimeout(() => {
        btn.classList.remove('copied');
        btn.innerHTML = '&#128203; Copiar';
      }, 2000);
    }).catch(() => {
      // Fallback
      const ta = document.createElement('textarea');
      ta.value = url; document.body.appendChild(ta);
      ta.select(); document.execCommand('copy');
      document.body.removeChild(ta);
      showToast('Link copiado!');
    });
  };

  function showToast(msg) {
    toast.textContent = msg;
    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), 2000);
  }

  // --- Countdown refresh ---
  setInterval(loadFiles, 30000); // refresh every 30s

  // --- Init ---
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

    def __init__(self, file_id: str, filename: str, ttl: int, created_at: float):
        self.file_id = file_id
        self.filename = filename
        self.ttl = ttl
        self.created_at = created_at

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
            "created_at": self.created_at
        }

    @classmethod
    def from_dict(cls, data: dict) -> "FileMetadata":
        return cls(
            file_id=data["file_id"],
            filename=data["filename"],
            ttl=data["ttl"],
            created_at=data["created_at"]
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
def get_file_paths(file_id: str) -> tuple[Path, Path]:
    """Get paths for file and its metadata"""
    file_path = DATA_DIR / file_id
    metadata_path = DATA_DIR / f"{file_id}.meta.json"
    return file_path, metadata_path


def cleanup_expired_files():
    """Remove expired files and their metadata"""
    cleaned = 0
    for metadata_file in DATA_DIR.glob("*.meta.json"):
        metadata = FileMetadata.from_file(metadata_file)
        if metadata and metadata.is_expired:
            file_id = metadata.file_id
            file_path, metadata_path = get_file_paths(file_id)

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
# Startup
# ---------------------------------------------------------------------------
@app.on_event("startup")
async def startup_event():
    """Start background cleanup task"""
    asyncio.create_task(cleanup_task())
    print(f"TmpUp started - data directory: {DATA_DIR}")
    print(f"Auto-cleanup every {CLEANUP_INTERVAL} seconds")


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------
@app.get("/health")
async def health_check():
    """Health check endpoint"""
    return {"status": "ok"}


@app.get("/api/files")
async def list_files():
    """List active (non-expired) files with metadata"""
    files = []
    for metadata_file in DATA_DIR.glob("*.meta.json"):
        metadata = FileMetadata.from_file(metadata_file)
        if metadata and not metadata.is_expired:
            files.append({
                "id": metadata.file_id,
                "filename": metadata.filename,
                "url": f"{BASE_URL}/d/{metadata.file_id}/{metadata.filename}",
                "expires_in": metadata.expires_in,
                "created_at": metadata.created_at
            })
    return sorted(files, key=lambda x: x["created_at"], reverse=True)


@app.post("/api/upload")
async def upload_file(request: Request):
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
    if ttl < 0 or (ttl > 86400 * 365 and ttl != 0):
        raise HTTPException(status_code=400, detail="TTL must be 0 (never expires) or between 1 and 31536000 seconds")

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
            created_at=time.time()
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


@app.get("/d/{file_id}/{filename}")
async def download_file(file_id: str, filename: str):
    """
    Download a file by ID and filename

    Returns 404 if file not found or expired
    """
    file_path, metadata_path = get_file_paths(file_id)

    # Load metadata
    metadata = FileMetadata.from_file(metadata_path)
    if not metadata:
        raise HTTPException(status_code=404, detail="File not found")

    # Check if expired
    if metadata.is_expired:
        # Cleanup expired file
        if file_path.exists():
            file_path.unlink()
        if metadata_path.exists():
            metadata_path.unlink()
        raise HTTPException(status_code=404, detail="File expired")

    # Verify file exists
    if not file_path.exists():
        raise HTTPException(status_code=404, detail="File not found")

    # Guess content type
    content_type, _ = mimetypes.guess_type(filename)
    if not content_type:
        content_type = "application/octet-stream"

    # Inline for images/viewable types, attachment for the rest
    inline_types = {"image/", "video/", "audio/", "text/", "application/pdf"}
    is_inline = any(content_type.startswith(t) for t in inline_types)

    headers = {
        "Content-Disposition": f'inline; filename="{filename}"' if is_inline else f'attachment; filename="{filename}"'
    }

    return FileResponse(
        path=file_path,
        media_type=content_type,
        headers=headers
    )


@app.get("/", response_class=HTMLResponse)
async def root():
    """Serve the upload frontend"""
    return HTMLResponse(content=HTML_TEMPLATE)


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8844"))
    uvicorn.run(app, host="0.0.0.0", port=port)
