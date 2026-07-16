# Nexus Companion

Cloudflare Worker que entrega o PWA de pareamento do NexusIDE. O navegador
recebe o link de sala somente no fragmento do URL, importa a chave AES-GCM via
WebCrypto e conversa com o relay cego usando frames selados.

O Worker não recebe, registra ou armazena chaves de sala, tokens de escrita ou
conteúdo de terminal.
