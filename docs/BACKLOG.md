# Backlog

## Mídia hospedada para o Buffer: pré-configurada e clara na UI

**Origem:** o perfil do LinkedIn precisou de Cloudflare R2 configurado à mão. Quando o post tem mídia, o kit sobe o arquivo, obtém uma URL pública e a passa para a API do Buffer.

**Problema:** essa configuração é manual, não aparece na UI e não há orientação de qual provedor usar.

**Pedido:**
- Na UI (`bun run ui`), uma seção "Hospedagem de mídia" mostra o provedor ativo, o estado (configurado ou não) e um teste de upload.
- Provedores suportados, escolhidos por variável ou pela UI: Cloudflare R2 (já existe), imgBB (já existe), Vercel Blob (novo), AWS S3 (novo, aceita bucket com URL pública).
- Cada provedor tem um passo a passo curto e as variáveis necessárias, com os nomes já presentes no `.env.example`.
- Sem provedor configurado, o kit avisa antes de aprovar um post com mídia, em vez de descartar a mídia em silêncio.

**Onde no código:** `packages/publishers/src/media-hosts.ts` (interface `MediaHost` em `packages/contracts/src/ports.ts`).

**Estado:** não iniciado.
