# TmpUp — Port Python → TypeScript (spec de portabilidade)

> **Status:** port concluído. O `app.py`/`test_app.py` original foi removido do repositório
> (o histórico do git preserva a versão Python); as referências a linhas do `app.py` abaixo
> são o mapa usado durante o port e apontam para o commit anterior à migração.


Origem: `app.py` (2102 linhas) e `test_app.py` (2534 linhas, 86 testes, 100% verdes).
Destino: Node 22 + TypeScript + Fastify 5 + `@modelcontextprotocol/sdk` + `sharp` + Vitest.

## Regras de fidelidade (obrigatórias)

1. **Portar 1:1.** Mesmas rotas, mesmos status codes, mesmos nomes de campos JSON
   (snake_case preservado), mesmos headers, mesmos templates HTML, mesmos eventos de log,
   mesmas mensagens de erro voltadas ao usuário.
2. **Sem redesenho.** Não "melhorar" contrato, não renomear campos, não mudar textos.
3. **Suíte portada 1:1.** Cada teste Python vira um teste Vitest equivalente em
   `test/*.test.ts`. Use `app.inject()` no lugar do `TestClient`.
4. **Imports relativos com extensão `.js`** (module NodeNext), ex.:
   `import { config } from "../config.js";`
5. Nada de dependência nova sem necessidade. Já disponíveis: `fastify`,
   `@fastify/cookie`, `@modelcontextprotocol/sdk`, `sharp`, `vitest`, `tsx`, `typescript`.

## Estrutura de módulos e superfície de exportação

### `src/config.ts` (PRONTO)
`config: Config` (mutável: `config.dataDir`, `config.apiKeys`),
`API_KEY_CLIENT = "api-key-client"`.
Campos: baseUrl, secretKey, googleClientId, googleClientSecret, allowedDomain,
sessionMaxAge (604800), maxMcpUploadSize (200MB), dataDir, port, httpHost,
apiKeys, pageSize (50), cleanupIntervalMs (60000).

### `src/logger.ts` (PRONTO)
`logEvent(event: string, fields?: Record<string, unknown>): void` →
`console.log(JSON.stringify({ svc: "tmpup", event, ...fields }))`.

### `src/types.ts` (PRONTO)
`FileMetadataData`, `PublicFileMetadata`, `FileListPage`, `UploadResult`.

### `src/auth.ts` (A)
- `class TimedSerializer` compatível com `itsdangerous.URLSafeTimedSerializer`
  (mesmo formato de token, HMAC-SHA1, key derivation django-concat) — sessões Python
  existentes continuam válidas após o cutover.
- `createSession(email: string, secretKey?: string): string`
- `verifySession(token: string | undefined, maxAge?: number): string | null`
- `verifyApiKey(headers: Record<string, string|string[]|undefined>): string | null`
  → `API_KEY_CLIENT` quando bate (comparação constant-time), `null` se
  `config.apiKeys` vazio / header ausente / não bate.
- `PUBLIC_PATHS = ["/health","/auth/login","/auth/google","/auth/callback","/auth/logout"]`
- `isPublicPath(pathname: string): boolean` (públicos + prefixos `/d/`, `/v/`, `/t/`)

### `src/storage.ts` (A)
- `class FileMetadata` com `fileId, filename, ttl, createdAt, views, downloads,
  lastViewedAt, lastDownloadedAt, sizeBytes`; getters `expiresAt`, `isExpired`,
  `expiresIn`; `toDict()`, estático `fromDict(data)`, estático
  `fromFile(metadataPath): FileMetadata | null`, `save(metadataPath)`.
- `validateTtl(ttl: unknown): number` (0..31536000 inteiro; bool/float → Error).
- `parseFileId(fileId: unknown): string` → UUID canônico minúsculo; erro
  `Invalid file ID: <x>` caso inválido (equivalente a `uuid.UUID`).
- `getFilePaths(fileId): { filePath: string; metadataPath: string }` (lança se inválido).
- `isImageFile(filename)`, `fileKind(filename)` (image/document/video/archive).
- `formatExpiry(expiresIn)` ("Nunca expira", "Expira em Xmin", "Expira em Xh Ymin",
  "Expira em N dia(s)").
- `fileMetaDict(metadata): PublicFileMetadata` (fallback de size via `stat`).
- `listActiveFiles(): PublicFileMetadata[]`, `getFileInfo(fileId): PublicFileMetadata | null`.
- `deleteThumbnail(canonicalFileId): void` (sufixos `.thumb.jpg`, `.thumb.fail`).
- `deleteFileById(fileId): boolean`, `extendFileTtl(fileId, ttl): PublicFileMetadata | null`.
- `cleanupExpiredFiles(): number` (imprime `Cleaned up N expired file(s)`; erros por
  arquivo imprimem `Error cleaning up <id>: <err>`).
- `generateThumbnail(filePath, thumbPath, maxSize = 200, fileId?): Promise<boolean>`
  via `sharp` (EXIF rotate, RGBA→fundo branco, sem ampliar, JPEG q70, arquivo temporário
  + rename; nunca lança; loga `thumbnail_generation_failed`).
- `ensureDataDir(): Promise<void>` e `dataDirPath(): string`.

### `src/files.ts` (A)
- `filterSortPaginateFiles(allFiles, { q, kind, sort, page }): FileListPage`
  (mesma semântica de `_filter_sort_paginate_files`).

### `src/templates/` (C)
- `list.ts` → `renderListPage(): string` (HTML_TEMPLATE, app.py 127–798)
- `login.ts` → `LOGIN_HTML` (app.py 1112–1150)
- `viewer.ts` → `renderViewerPage(vars)` (VIEWER_TEMPLATE, app.py 1489–1606)
- `mcpSetup.ts` → `renderMcpSetupPage(vars)` (MCP_SETUP_TEMPLATE, app.py 1827–1960)
- `index.ts` reexporta.
- Conteúdo HTML/CSS/JS copiado literalmente; só as interpolações mudam
  (`{filename}` → função, `{{BASE_URL}}` → replace).
- `renderViewerPage({ filename, imageUrl, downloadUrl, imageUrlAbsJson, fileIdJson, expiryText })`
- `renderMcpSetupPage({ baseUrl, mcpUrlJs, jsonConfig })`

### `src/routes/` (D)
- `auth.ts`: GET /auth/login, /auth/google, /auth/callback, /auth/logout, /api/me
- `files.ts`: GET /health, GET /api/files, GET/DELETE /api/files/:file_id,
  PATCH /api/files/:file_id/ttl, POST /api/upload, POST /admin/set-all-infinite
- `transfer.ts`: GET /d/:file_id/:filename (`downloadFile`),
  GET /v/:file_id/:filename (`viewFile`), GET /t/:file_id/:filename (`thumbnailFile`)
  — helpers síncronos exportados com os mesmos nomes.
- `pages.ts`: GET /, GET /mcp-setup

### `src/mcp.ts` (E)
- `createMcpServer(): McpServer` com as 5 tools: `upload_file`, `list_files`,
  `get_file_info`, `extend_ttl`, `delete_file` (mesmos nomes, parâmetros, docstrings
  e mensagens de erro). Exporta `mcp` (instância) para os testes.
- `registerMcpRoutes(app: FastifyInstance): Promise<void>` monta `/mcp` (Streamable HTTP).

### `src/server.ts` (orquestrador)
- `buildServer(): Promise<FastifyInstance>` — registra cookie, hook de auth, rotas e MCP.
- `main.ts` — `buildServer()` + `listen({ host, port })` + loop de cleanup.

## Semântica crítica (não errar)

- `expiresIn`: `ttl === 0 ? -1 : max(0, trunc(createdAt + ttl - now))`.
- `pageSize` 50; `total_pages = ceil(total/50)`;
  `expiring_soon_count = |{f : 0 <= expires_in < 3600}|`.
- Sort: `name` (lower), `size` (desc), `expiry` (inf por último), default `date` desc.
- Upload vazio → 400 `Empty file`; sem `X-Filename` → 400 `X-Filename header required`;
  `X-TTL` inválido → 400 `X-TTL must be a valid integer`.
- Download: tipo inline para `image/`, `video/`, `audio/`, `text/`, `application/pdf`;
  `?dl=1` força attachment (`dl` em `0/false/no` não força);
  attachment usa `filename*=UTF-8''<urlencoded>`; incremental de views/downloads
  sob lock.
- View: não-imagem → 302 para `/d/<id>/<filename>`; HTML escapado (XSS).
- Thumbnail: cache `<id>.thumb.jpg`, marcador de falha `<id>.thumb.fail` (fallback = imagem
  original), `Cache-Control: public, max-age=31536000, immutable`, não-imagem → 404
  `File is not an image`, e não incrementa views/downloads.
- Middleware: público → passa; sessão ou API key → passa; `Accept: text/html` → 302
  `/auth/login`; senão 401 JSON `{"error":"unauthorized","detail":"Provide session cookie or X-API-Key header"}`.
- Cookie de sessão: `httpOnly`, `secure`, `sameSite: "lax"`, `maxAge: 604800`.
- MCP upload: limite 200MB (tamanho decodificado), base64 inválido → `Invalid base64: ...`,
  vazio → `Empty file`, `get_file_info`/delete de inexistente segue o original.

## Testes (paridade)

`test/helpers.ts` (PRONTO) expõe `makeDataDir()`, `useApiKeys()`,
`restoreConfig()`, `buildTestServer()`.
Arquivos: `test/storage.test.ts` (A), `test/auth.test.ts` (A/B), `test/templates.test.ts` (C),
`test/routes.test.ts` (D), `test/mcp.test.ts` (E).
Adaptações conscientes (documentar no teste): os testes Python que verificam
`run_in_threadpool`/funções síncronas viram "handler é async e usa fs/promises"
(o objetivo é não bloquear o event loop).

## Divergências conscientes (adaptações do port)

1. **Concorrência/IO.** O Python descarrega IO bloqueante num threadpool
   (`run_in_threadpool`); no Node o caminho de request usa `node:fs/promises`.
   Os testes pytest que verificavam "handler async + helper síncrono" foram portados
   como "os handlers/helpers retornam promises" mais um teste estático que garante que
   não existe chamada `*Sync` de fs no caminho de request.
2. **Um único tipo numérico em JS.** `validateTtl(1.0)` é indistinguível de
   `validateTtl(1)`; booleanos e não-inteiros continuam sendo rejeitados (o teste de
   `bool` do Python é preservado).
3. **`page` inválido.** O FastAPI responde 422 para `?page=abc`; o port cai para a
   página 1. Não coberto pela suíte.
4. **Método não suportado.** O Fastify responde 404 para um path conhecido com método
   não registrado (o FastAPI responde 405). A exceção é `/mcp`, que responde 405
   explicitamente para GET/DELETE/PUT/PATCH/OPTIONS (evita o stream SSE infinito).
5. **MCP stateless.** Um `McpServer`/transport por POST, com respostas JSON; o Python
   usava um session manager com estado. Nomes de tools, parâmetros, docstrings e
   mensagens de erro são idênticos.
6. **`parseFileId`** aceita as formas canônica/dashed/brace/urn, mas não os separadores
   `_` que o `uuid.UUID` do Python tolera (mais estrito; path traversal é impossível
   dos dois jeitos).
7. **Sessões.** O formato do token é byte-compatível com o itsdangerous (HMAC-SHA1 +
   derivação django-concat), então sessões emitidas pelo serviço Python continuam
   válidas desde que `SECRET_KEY` seja o mesmo. Payloads não-ASCII são escapados de
   forma diferente (JSON.stringify vs. ensure_ascii), mas os dois lados decodificam o
   token um do outro.
8. **Thumbnails** usam `sharp` no lugar do Pillow (EXIF rotate, RGBA sobre branco, sem
   ampliar, JPEG q70, arquivo temporário + rename atômico).
9. **Upload vazio.** O `except Exception` do app.py reembrulhava o 400 "Empty file" num
   500 "Upload failed: ..."; o port preserva esse comportamento.
10. **404 de rota desconhecida** devolve `{"detail":"Not Found"}` (compatível com o
    FastAPI).
11. **Templates** ficam em `src/templates/*.html` copiados byte a byte do app.py e são
    carregados no boot; o `npm run build` copia os arquivos para `dist/templates/`.

