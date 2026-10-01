# Upload de vídeos através do Cloudflare

## Objetivo
Manter o domínio e o proxy Cloudflare, enviando arquivos grandes em requisições pequenas. O caminho legado de upload permanece compatível.

## Design
- Interface inicia sessão autenticada com nome, tamanho e TTL.
- Envia blocos sequenciais de até 8 MiB, com offset explícito. Reenvio de um bloco já confirmado é idempotente; offsets inválidos são rejeitados.
- Servidor mantém arquivo temporário em disco fora da listagem pública. Somente a conclusão com tamanho exato publica arquivo e metadata existentes.
- Sessões ficam associadas à credencial autenticada; operações de escrita são serializadas; uploads incompletos expiram e são limpos.
- Interface mostra progresso total e repete falhas transitórias de blocos, sem reiniciar todo o vídeo. Erros HTTP e timeout recebem mensagens claras.
- Não alterar DNS, desativar proteção ou aumentar o tamanho máximo por requisição no proxy.

## Implementação e verificação
1. Testes primeiro: autenticação, sessão, offsets/reenvio, publicação exata, tamanho/TTL, isolamento e limpeza.
2. Módulo de upload em partes e registro de rotas.
3. Interface usando blocos e testes de contrato/comportamento.
4. Rodar testes completos, typecheck e build. Revisar diff.
5. Publicar no serviço Railway existente, se autorizado, e verificar upload maior que 100 MB pelo domínio Cloudflare.
