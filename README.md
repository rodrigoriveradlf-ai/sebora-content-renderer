# sebora-content-renderer

Servicio HTTP que renderiza assets de Sebora (PNG ahora; MP4 vía HyperFrames más adelante) a partir de templates HTML. Consumido por workflows de n8n.

## Por qué existe

n8n no tiene un nodo nativo para ejecutar Puppeteer. Levantar este servicio aparte —en el mismo VPS de Easypanel— permite que n8n haga un `HTTP Request` sencillo y reciba el PNG ya renderizado, sin tener que orquestar Chromium dentro del propio n8n.

Reusa el approach probado en `pdfs/generate.js` del repo (Puppeteer + HTML→imagen), pero apuntado a viewports de social en lugar de A4.

## Setup local

```bash
cd social-media/content-renderer
cp .env.example .env
# editar .env si querés cambiar el puerto o setear RENDERER_AUTH_TOKEN
npm install
npm start
```

Primera vez tarda ~30-60s porque Puppeteer descarga su build de Chromium (~170 MB).

## Endpoints

### `GET /health`

Healthcheck sin autenticación. Útil para Easypanel y para que n8n verifique que el servicio responde.

```bash
curl http://localhost:4123/health
# → {"status":"ok","uptime":3.21}
```

### `POST /render-image`

Genera un PNG a partir de un template HTML y un objeto de props.

**Headers:**
- `Content-Type: application/json`
- `X-Renderer-Token: <RENDERER_AUTH_TOKEN>` (solo si está configurado el .env)

**Body:**
```json
{
  "template_id": "post-cita-dato",
  "format": "post",
  "props": {
    "pilar_label": "MECANISMO REAL",
    "hook": "Lavarte más NO quita la caspa",
    "subtexto": "No es higiene. Es un hongo (Malassezia) que vive en tu cuero cabelludo.",
    "disclaimer": "Información educativa. No reemplaza consulta médica."
  }
}
```

**Campos:**
- `template_id` (string, requerido): nombre del archivo en `templates/` sin extensión. Solo `[a-z0-9_-]+`.
- `format` (string, opcional, default `"post"`): preset de viewport. Valores: `post` 1080×1080, `carrusel` 1080×1080, `reel_frame` 1080×1920, `story` 1080×1920.
- `viewport` (objeto, opcional): override del viewport: `{ "width": N, "height": N, "deviceScaleFactor": N }`.
- `props` (objeto): valores que se inyectan en los `{{placeholder}}` del template. Solo strings/números, escapados como HTML.

**Respuesta:**
- `200` con body binario `image/png`.
- `400` si falta `template_id` o el `format` es desconocido.
- `401` si `RENDERER_AUTH_TOKEN` está configurado y el header no coincide.
- `500` si Puppeteer falla.

### Test rápido

```bash
curl -X POST http://localhost:4123/render-image \
  -H "Content-Type: application/json" \
  -d '{
    "template_id": "post-cita-dato",
    "format": "post",
    "props": {
      "pilar_label": "MECANISMO REAL",
      "hook": "Lavarte más NO quita la caspa",
      "subtexto": "No es higiene. Es un hongo que vive en tu cuero cabelludo.",
      "disclaimer": "Información educativa. No reemplaza consulta médica."
    }
  }' \
  --output test.png
```

Abrir `test.png` — debería verse un cuadrado 1080×1080 con la estética dark de Sebora.

## Templates disponibles

| Template | Formato | Uso |
|---|---|---|
| `post-cita-dato` | post 1080×1080 | Post estático con hook + subtexto. Pilar P1 mecanismo, P2 diagnóstico, anti-mitos, datos científicos. |

Más vendrán conforme avancemos en Fase B/C: `post-anti-mito`, `carrusel-hook`, `carrusel-slide-comparativa`, `carrusel-cta`, etc.

## Cómo agregar un template nuevo

1. Crear `templates/nuevo-template.html`.
2. Inline todo el CSS dentro de `<style>` (los archivos externos no funcionan porque el HTML se renderiza con `setContent`, sin servir desde un directorio web).
3. Usar `{{nombre_placeholder}}` para los valores dinámicos. Solo strings/números.
4. Para fonts: usar `<link>` a Google Fonts. Puppeteer espera a `document.fonts.ready` antes del screenshot.
5. Reiniciar el servicio NO es necesario (los templates se leen del disco por request).

## Deploy a Easypanel (cuando esté listo)

1. Push del repo al VPS.
2. En Easypanel: crear nueva app "Node.js" apuntando a este subdirectorio.
3. Build command: `npm install`.
4. Start command: `npm start`.
5. Variables de entorno: `PORT=4123`, `RENDERER_AUTH_TOKEN=<token-largo>`.
6. **No exponer públicamente.** Solo permitir tráfico desde el contenedor de n8n (red interna de Easypanel).
7. En n8n: HTTP Request node apunta a `http://content-renderer:4123/render-image` (o el nombre que use Easypanel para el service discovery interno).

## Voz / diseño

Los templates respetan el sistema visual documentado en `social-media/branding/sebora-visual-system.md`:

- Paleta: `#4CAF7B` (verde Sebora), `#0F1419` (dark), `#F4EFE6` (cream), `#FFFFFF`, `#FF8B7E` (coral), `#6B7280` (gris).
- Tipografía: Inter (400–800) para todo, JetBrains Mono para metadata si aplica.
- Logo: gota verde con punto blanco interno, igual al usado en `pdfs/generate.js`.

Antes de aceptar un template nuevo, validar visualmente que se mantiene la coherencia con el resto del sistema (`Sebora_Logo_Sistema_Completo_v2.html`, etc.).
