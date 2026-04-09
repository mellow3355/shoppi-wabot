# shoppi-wabot

WhatsApp bot multi-tenant para Shoppi. Cada tenant tiene su propia sesion de WA y su prompt personalizado para Claude Haiku.

## Arquitectura

- Servidor Express en Cloud Run, una sola instancia que mantiene N clientes whatsapp-web.js en memoria.
- Sesiones persistidas en `/data/wa-sessions` (en Cloud Run con volumen de Cloud Storage opcional).
- Respuestas generadas por Claude Haiku 4.5 con system prompt por tenant.
- Logs de mensajes en Firestore: `tenants/{id}/waLogs/`.
- Config por tenant: `tenants/{id}/settings/whatsapp` con campos:
  - `enabled` (bool)
  - `customPrompt` (string opcional)
  - `onlyAfterHours` (bool) — si true, en horario solo manda welcome y deja el chat a las chicas.
  - `scheduleText` (string opcional, info de horario para el LLM)

## Local dev

```bash
npm install
GOOGLE_APPLICATION_CREDENTIALS=path/to/sa.json \
ANTHROPIC_API_KEY=sk-ant-... \
ADMIN_TOKEN=changeme \
PORT=8080 \
node server.js
```

## Deploy a Cloud Run

1. **Crear repo** en Artifact Registry (una vez):
   ```bash
   gcloud artifacts repositories create shoppi-wabot --repository-format=docker --location=us-central1
   ```

2. **Build y push**:
   ```bash
   gcloud builds submit --tag us-central1-docker.pkg.dev/shoppi-proyect/shoppi-wabot/wabot:latest
   ```

3. **Deploy**:
   ```bash
   gcloud run deploy shoppi-wabot \
     --image us-central1-docker.pkg.dev/shoppi-proyect/shoppi-wabot/wabot:latest \
     --region us-central1 \
     --platform managed \
     --allow-unauthenticated \
     --memory 1Gi \
     --cpu 1 \
     --min-instances 1 \
     --max-instances 1 \
     --timeout 3600 \
     --set-env-vars "ADMIN_TOKEN=...,ANTHROPIC_API_KEY=sk-ant-..."
   ```

   IMPORTANTE: `--min-instances 1` para que la sesion de WA no se pierda. `--max-instances 1` porque whatsapp-web.js no soporta multi-instance (las sesiones rompen).

## Endpoints

Todos requieren header `X-Admin-Token: <ADMIN_TOKEN>` salvo `/health`.

- `GET /health`
- `POST /tenants/:id/start` — inicializa/levanta el bot del tenant. Devuelve `{ok}`.
- `POST /tenants/:id/stop` — desconecta y libera memoria.
- `GET /tenants/:id/status` — `{status: 'qr'|'ready'|'starting'|'disconnected'|'stopped', qr: dataUrl?}`.

## Flujo del primer pareo

1. Tenant entra al admin → tab WhatsApp Bot → click Activar.
2. Admin llama `POST /tenants/:id/start`.
3. Admin polling `GET /tenants/:id/status` cada 2 seg.
4. Cuando llega `{status:'qr', qr:dataUrl}`, lo muestra como imagen.
5. Tenant escanea con WhatsApp (Configuracion -> Dispositivos vinculados).
6. Status pasa a `ready`. Bot ya responde.
