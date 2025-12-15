# Backend API

Backend construído com Nest.js, Prisma e Socket.io para comunicação em tempo real.

## Tecnologias

- **Nest.js** - Framework Node.js modular e escalável
- **Prisma** - ORM moderno e type-safe
- **Socket.io** - WebSocket para comunicação em tempo real
- **TypeScript** - Tipagem estática

## Estrutura do Projeto

```
src/
├── app.controller.ts          # Controller REST principal
├── app.module.ts              # Módulo raiz
├── config/                    # Módulo de configuração
├── egress/
│   └── media-egress.server.ts # Servidor WS para egress de áudio/vídeo (track egress)
├── livekit/
│   ├── livekit-egress.service.ts     # Faz start automático do Track Egress via API
│   ├── livekit-webhook.controller.ts # Webhook que reage aos eventos do LiveKit
│   └── livekit-webhook.module.ts
├── pipeline/
│   ├── audio-pipeline.module.ts      # Wiring DI da pipeline
│   ├── audio-pipeline.service.ts     # Bufferiza e agrupa áudio, gera WAV
│   └── hume-stream.service.ts        # Integração em tempo real com Hume (WS)
├── prisma/
│   ├── prisma.module.ts
│   └── prisma.service.ts
├── sessions/
│   ├── sessions.module.ts
│   └── sessions.service.ts           # Persistência de sessões (room SID)
├── types/
│   └── ws-stub.d.ts
├── websocket/
│   ├── websocket.gateway.ts          # Socket.io (chat/demo)
│   └── websocket.module.ts
└── main.ts
```

## Instalação

1. Instale as dependências:
```bash
pnpm install
```

2. Configure as variáveis de ambiente:
```bash
cp env.example .env
```

O arquivo `.env` já está configurado com as credenciais padrão.

3. Configure o banco de dados PostgreSQL:

**Opção A - Sem Docker (ambiente local):**
```bash
# Certifique-se de que o PostgreSQL está instalado e rodando
# macOS: brew services start postgresql@16
# Linux: sudo systemctl start postgresql

# Execute o script de setup
./setup-database.sh
```

**Opção B - Com Docker:**
```bash
docker-compose up -d
```

4. Configure o Prisma:
```bash
# Gerar o cliente Prisma
pnpm prisma:generate

# Criar e aplicar as migrações
pnpm prisma:migrate
```

## Configuração sensível

O backend depende de um arquivo `.env` com credenciais de banco, LiveKit e integrações externas. Use `apps/backend/env.example` como referência e preencha os valores adequados para o seu ambiente (produção, staging, desenvolvimento).

## Executando a aplicação

### Desenvolvimento
```bash
pnpm start:dev
```

### Produção
```bash
pnpm build
pnpm start:prod
```

## Banco de Dados

### Configuração Local (sem Docker)

O projeto inclui um script `setup-database.sh` para configurar o PostgreSQL localmente.

**Pré-requisitos:**
- PostgreSQL instalado (macOS: `brew install postgresql@16`)
- PostgreSQL rodando (macOS: `brew services start postgresql@16`)

**Executar o setup:**
```bash
./setup-database.sh
```

Este script irá:
- Criar o usuário `user` com senha `password`
- Criar o banco de dados `live_meeting`
- Configurar as permissões necessárias

### Configuração com Docker

O projeto também inclui um `docker-compose.yml` para executar o PostgreSQL em container.

**Iniciar o banco de dados:**
```bash
docker-compose up -d
```

**Parar o banco de dados:**
```bash
docker-compose down
```

**Parar e remover volumes (apaga os dados):**
```bash
docker-compose down -v
```

**Ver logs do banco:**
```bash
docker-compose logs -f postgres
```

## Scripts disponíveis

- `pnpm start:dev` - Inicia em modo desenvolvimento com watch
- `pnpm build` - Compila o projeto
- `pnpm start:prod` - Inicia em modo produção
- `pnpm test` - Executa os testes
- `pnpm lint` - Executa o linter
- `pnpm prisma:generate` - Gera o cliente Prisma
- `pnpm prisma:migrate` - Cria e aplica migrações
- `pnpm prisma:studio` - Abre o Prisma Studio

## WebSocket

O WebSocket está configurado e disponível em `ws://localhost:3001`. O gateway está configurado para aceitar conexões de qualquer origem em desenvolvimento.

### Eventos disponíveis:

- `message` - Envia e recebe mensagens
- `join-room` - Entra em uma sala
- `leave-room` - Sai de uma sala

## Egress de Mídia (recepção)

Este backend expõe endpoints WebSocket para receber Egress de Áudio e Vídeo do LiveKit (Track Egress → WebSocket), com processamento interno via pipeline de áudio e integração com serviços externos.

### Áudio Egress com Pipeline Interna

**Endpoint:** `ws://localhost:3001/egress-audio`

**Query params suportados:**
- `roomName` (obrigatório) - Nome da sala LiveKit
- `participant` (opcional) - Identidade do participante
- `trackId` (opcional) - ID do track de áudio
- `sampleRate` (padrão: 48000) - Taxa de amostragem em Hz
- `channels` (padrão: 1) - Número de canais (1=mono, 2=estéreo)
- `meetingId` (opcional) - ID da reunião (resolvido automaticamente se não fornecido)
- `groupSeconds` (opcional) - Override do tempo de agrupamento em segundos

**Fluxo de processamento:**

1. **Recepção**: WebSocket recebe chunks PCM (s16le) em tempo real
2. **Buffer**: Pipeline interna agrupa chunks em memória (padrão: 2 segundos)
3. **Flush**: Quando atinge threshold (tempo ou tamanho), o bloco é disparado
4. **Processamento**: Normalização de volume opcional antes do envio
5. **Formato**: Geração de header WAV (PCM s16le) para o bloco agregado
6. **Streaming + Arquivo**:
   - **Streaming**: o chunk é enviado via WebSocket para o Hume (prosódia) quando as credenciais estão configuradas
   - **Arquivo**: o mesmo chunk é persistido no diretório de saída de áudio (`<meetingId>/`)

**Logs de pipeline:**
- Arquivos de log em `storage/pipeline-logs/<meetingId>.log`
- Registra cada flush com timestamp, tamanho e metadados

### Variáveis de ambiente (mídia e pipeline)

> Consulte o arquivo `.env` para configurar diretórios de saída, janela de agrupamento da pipeline e credenciais de streaming em tempo real.

### Como iniciar o Track Egress (exemplo)

Do lado do servidor LiveKit (ou de um serviço seu), inicie um Track Egress com saída WebSocket apontando para este backend:

```ts
import { EgressClient } from 'livekit-server-sdk';

const egress = new EgressClient('https://<livekit-host>', '<api-key>', '<api-secret>');

await egress.startTrackEgress({
  roomName: 'my-room',
  trackId: 'audio-track-id',
  websocketUrl: 'ws://localhost:3001/egress-audio?roomName=my-room&participant=user1&trackId=audio-track-id&sampleRate=48000&channels=1&meetingId=RM_123&groupSeconds=2'
});
```

**Notas:**
- O LiveKit enviará frames binários (PCM s16le) e frames texto JSON com eventos (ex.: `{ "muted": true }`)
- Quando `muted`, o servidor pausa a gravação
- O `meetingId` pode ser omitido se a sessão já existir no banco (resolvido por `roomName`)
- O `groupSeconds` permite override do tempo de agrupamento por chamada
- Este endpoint é apenas para desenvolvimento; adicione autenticação/assinatura de URL antes de expor publicamente

### Integração Hume

Com as credenciais do Hume configuradas o backend abre, por participante/track, um WebSocket dedicado para o endpoint do serviço e envia os blocos agregados em tempo real.

**Fluxo resumido:**
- Adiciona o header `X-Hume-Api-Key` (quando definido).
- Após o `open`, envia uma mensagem de configuração mínima (`{ models: { prosody: {} } }`).
- Cada flush vira um frame WAV em base64 enviado para o Hume.
- Mensagens recebidas do Hume são logadas para inspeção.
- Quedas de conexão limpam o cache e forçam reabertura automática na próxima remessa de áudio.

**Sem chave do Hume:**
- A pipeline continua gerando arquivos `.wav` e logs locais.
- O console registra que o envio externo foi ignorado.

### Vídeo Egress (bytestream codificado)

**Endpoint:** `ws://localhost:3001/egress-video`

**Query params suportados:**
- `roomName` (obrigatório) - Nome da sala LiveKit
- `participant` (opcional) - Identidade do participante
- `trackId` (opcional) - ID do track de vídeo
- `codec` (obrigatório) - `h264` | `vp8` | `vp9` (define a extensão do arquivo)
- `meetingId` (opcional) - ID da reunião (resolvido automaticamente se não fornecido)

**Saída:**
- Arquivos `.h264` ou `.ivf` armazenados no diretório de vídeo configurado (`<meetingId>/`)
- Estrutura de diretórios organizada por `meetingId`

> **Observação:** O servidor grava o bytestream codificado sem empacotamento (sem MP4/WebM). Para playback, use ferramentas de linha de comando (ex.: ffmpeg) para empacotar.

### Como iniciar o Track Egress de vídeo (exemplo)

```ts
import { EgressClient } from 'livekit-server-sdk';

await egress.startTrackEgress({
  roomName: '<roomName>',
  trackId: '<videoTrackId>',
  websocketUrl: 'ws://localhost:3001/egress-video?roomName=<roomName>&participant=<identity>&trackId=<videoTrackId>&codec=h264',
});
```

## Gerenciamento de Sessões

O backend gerencia automaticamente sessões de reunião através de webhooks do LiveKit.

### Webhook Endpoint

**Endpoint:** `POST /livekit/webhook`

**Eventos suportados:**
- `room_started` / `room_created` - Cria ou ativa uma sessão
- `room_finished` / `room_ended` / `room_deleted` - Encerra uma sessão

**Modelo de Sessão:**
```typescript
{
  id: string;              // UUID
  meetingId: string;       // Identificador único (recomendado: room.sid)
  roomName: string;        // Nome da sala LiveKit
  roomSid: string | null;  // SID da sala (se disponível)
  status: 'ACTIVE' | 'ENDED';
  startedAt: Date;
  endedAt: Date | null;
}
```

## Feedback em Tempo Real (Host)

O backend gera feedbacks para o anfitrião com base no áudio dos participantes (Hume prosody + sinais locais).

### Tipos Suportados
- volume_baixo / volume_alto
- silencio_prolongado
- overlap_fala
- monologo_prolongado

### Entrega
- Socket.IO: o anfitrião deve ingressar na sala `feedback:<meetingId>`
- Evento: `feedback` com payload:
```json
{
  "id": "fb-uuid",
  "type": "volume_baixo",
  "severity": "warning",
  "ts": 1731368534123,
  "meetingId": "RM_123",
  "participantId": "user_abc",
  "window": { "start": 1731368531000, "end": 1731368534000 },
  "message": "Fulano: volume baixo; aproxime-se do microfone.",
  "tips": ["Verifique entrada de áudio"],
  "metadata": { "rmsDbfs": -29.7, "speechCoverage": 0.62 }
}
```

### Identidade/Papel
- O frontend deve emitir token com `metadata` do LiveKit contendo `{"roles":["host"],"name":"<Nome>"}` para o anfitrião.
- O backend identifica múltiplos anfitriões e não gera feedback sobre o próprio anfitrião.

### Endpoints de Observabilidade
- `GET /feedback/debug/:meetingId` — visão instantânea por participante (cobertura de fala 10s, RMS médio 3s, EMA de RMS)
- `GET /feedback/metrics/:meetingId` — contadores por tipo e média de latência (ms) das últimas amostras

### Persistência (TTL)
- Feedbacks são gravados em `FeedbackEvent` (Prisma). TTL configurável por `FEEDBACK_TTL_DAYS` (padrão 14).
- Limpeza oportunista ocorre nas inserções (exclui expirados).

**Associação automática:**
- Egress streams são automaticamente associados a sessões via `meetingId`
- Se `meetingId` não for fornecido na query, o sistema busca sessão ativa por `roomName`
- Arquivos são organizados por `meetingId` nas estruturas de diretório

### Configuração do Webhook no LiveKit

Configure o LiveKit para enviar webhooks para este backend:

```yaml
# livekit.yaml
webhook:
  urls:
    - http://localhost:3001/livekit/webhook
  api_key: devkey
  api_secret: devsecret12345678901234567890
```

## API REST

- `GET /` - Status da API
- `GET /health` - Health check
- `POST /livekit/webhook` - Webhook do LiveKit para gerenciamento de sessões

## Estrutura de Armazenamento

```
storage/
├── egress/
│   ├── audio/
│   │   └── <meetingId>/
│   │       └── <timestamp>_<room>_<participant>_<track>.wav
│   └── video/
│       └── <meetingId>/
│           └── <timestamp>_<room>_<participant>_<track>.<codec>
├── pipeline-logs/
│   └── <meetingId>.log
└── ...
```

## Próximos passos

- [x] Pipeline de áudio interna com buffer
- [x] Integração com Hume (streaming WebSocket)
- [x] Gerenciamento de sessões via webhook
- [x] Associação automática de streams com sessões
- [ ] Adicionar autenticação (JWT) para endpoints
- [ ] Implementar validação de dados mais robusta
- [ ] Adicionar testes automatizados
- [ ] Suporte a compressão Opus opcional

