# TmpUp

Serviço de upload temporário de arquivos com expiração automática, viewer de imagens,
thumbnails e servidor MCP — porta do antigo `app.py` (FastAPI/Python) para **Node 22 + TypeScript + Fastify**.

## Stack

- **Fastify 5** (rotas, hooks, streaming de arquivos)
- **@modelcontextprotocol/sdk** (servidor MCP em `/mcp`, Streamable HTTP, modo stateless)
- **sharp** (thumbnails; substitui o Pillow)
- **@fastify/cookie** + assinatura de sessão compatível com `itsdangerous.URLSafeTimedSerializer`
- **Vitest** (suíte portada 1:1 da suíte pytest)
- Armazenamento em disco: `<DATA_DIR>/<uuid>` + sidecar `<uuid>.meta.json`

## Variáveis de ambiente

| Variável | Padrão | Descrição |
|---|---|---|
| `BASE_URL` | `https://tmpup.douravita.com.br` | Base das URLs públicas (`/d/`, viewer, config MCP) |
| `SECRET_KEY` | — (**obrigatória**) | Chave de assinatura do cookie de sessão. O processo **recusa iniciar** sem ela (chave vazia = cookie forjável). **Mantenha o mesmo valor do serviço Python** para não invalidar as sessões existentes |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | vazio | OAuth Google (login restrito a `@douravita.com.br`) |
| `TMPUP_API_KEYS` | vazio | Lista separada por vírgula de chaves `X-API-Key` (clients headless/MCP). Vazio = desabilitado |
| `DATA_DIR` | `/data` | Diretório dos arquivos e sidecars |
| `PORT` | `8844` | Porta HTTP |
| `HOST` | `0.0.0.0` | Interface de bind |

## Comandos

```bash
npm install
npm run dev         # tsx watch src/main.ts
npm test            # vitest run (suíte completa)
npm run typecheck   # tsc --noEmit
npm run build       # tsc -p tsconfig.build.json + copia os templates para dist/
npm start           # node dist/main.js (produção)
```

## Rotas

| Método | Rota | Descrição |
|---|---|---|
| GET | `/` | Frontend (upload, busca, filtros, ações em lote) |
| GET | `/health` | Health check (público) |
| GET | `/auth/login`, `/auth/google`, `/auth/callback`, `/auth/logout` | Login Google (públicos) |
| GET | `/api/me` | Email da sessão atual |
| GET | `/api/files` | Lista paginada (`page`, `q`, `kind`, `sort`) |
| GET | `/api/files/:id` | Metadados de um arquivo |
| DELETE | `/api/files/:id` | Remove arquivo + sidecar + thumbnail |
| PATCH | `/api/files/:id/ttl` | Renova/atualiza TTL (`{"ttl": 3600}`, `0` = nunca expira) |
| POST | `/api/upload` | Upload cru (headers `X-Filename` url-encoded, `X-TTL`) |
| GET | `/d/:id/:filename` | Download/view do arquivo (`?dl=1` força attachment) |
| GET | `/v/:id/:filename` | Viewer HTML (imagens) ou redirect 307 |
| GET | `/t/:id/:filename` | Thumbnail JPEG (cache imutável, fallback = original) |
| GET | `/mcp-setup` | Página com instruções de configuração do MCP |
| POST | `/admin/set-all-infinite` | Marca todos os arquivos como "nunca expira" |

Todas as rotas exigem sessão (cookie) ou `X-API-Key`, exceto `/health`, as rotas de auth e os prefixos `/d/`, `/v/`, `/t/`.

## MCP

Servidor MCP montado em `/mcp` (POST, Streamable HTTP, stateless), com as ferramentas
`upload_file`, `list_files`, `get_file_info`, `extend_ttl` e `delete_file`.
Clientes se autenticam com o header `X-API-Key: <chave de TMPUP_API_KEYS>`:

```json
{
  "mcpServers": {
    "tmpup": {
      "type": "http",
      "url": "https://tmpup.douravita.com.br/mcp",
      "headers": { "X-API-Key": "SUA_CHAVE_AQUI" }
    }
  }
}
```

## Docker

```bash
docker build -t tmpup .
docker run -p 8844:8844 -v tmpup-data:/data \
  -e SECRET_KEY=... -e GOOGLE_CLIENT_ID=... -e GOOGLE_CLIENT_SECRET=... \
  -e TMPUP_API_KEYS=... tmpup
```

A imagem roda como o usuário `node` (não-root) e o `SECRET_KEY` é usado para assinar os
cookies de sessão — troque-o e todos os logins são invalidados. Com volume nomeado o
Docker preserva o dono de `/data` (uid 1000); com bind mount, garanta
`chown 1000:1000` no diretório do host.

## Notas de portabilidade

- Sessões assinadas pelo serviço Python continuam válidas (mesmo formato itsdangerous,
  HMAC-SHA1 + derivação django-concat). Basta manter o mesmo `SECRET_KEY`.
- Os templates HTML/CSS/JS foram copiados byte a byte para `src/templates/*.html`
  (há testes de hash garantindo a paridade).
- Toda I/O de arquivo no caminho de request usa `node:fs/promises` (o equivalente Node
  do `run_in_threadpool` do FastAPI), para não bloquear o event loop.
