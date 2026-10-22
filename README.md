# Tiempo SMN

Web app (PWA) para consultar el tiempo actual y el pronóstico de 7 días de cualquier localidad argentina con datos del Servicio Meteorológico Nacional. Funciona en cualquier navegador, se puede instalar en el celular y está pensada para empaquetarse después como app de Android.

---

## 1. Cómo funciona la API del SMN (lo que se investigó)

Probado el 22/10/2026 desde el navegador:

| Endpoint (`https://ws1.smn.gob.ar/v1`) | ¿Pide token? | ¿Se puede llamar desde cualquier web? |
|---|---|---|
| `/georef/location/search?name=texto` | No | **Sí** |
| `/georef/location/coord?lat=..&lon=..` | Sí | No |
| `/weather/location/{id}` | Sí | No |
| `/forecast/location/{id}` | Sí | No |
| `/warning/alert/location/{id}` | Sí | No |

- La API vieja (`ws.smn.gob.ar/map_items/...`) está caída (error 503).
- El token es un JWT que va en el header `Authorization: JWT <token>`, **dura 1 hora** y viene escrito dentro del HTML de `www.smn.gob.ar` (`localStorage.setItem('token', '...')`).
- La API solo acepta ese header desde `smn.gob.ar`: un navegador en otro sitio no puede mandarlo (lo bloquea el CORS).
- `www.smn.gob.ar` está detrás de un desafío de Cloudflare: un `requests.get()` común no llega al HTML. Hace falta un navegador real (por eso los proyectos de Home Assistant usan Selenium/Playwright).

**Conclusión:** la búsqueda de localidades se puede llamar directo desde la app, pero para el tiempo y el pronóstico hace falta un intermediario (proxy) que tenga el token y le agregue el header.

## 2. Arquitectura

```
 [App web / Android]  ── búsqueda ──────────────►  ws1.smn.gob.ar  (abierta)
        │
        └── tiempo / pronóstico ─► [Proxy: Cloudflare Worker] ─► ws1.smn.gob.ar (con token)
                                         ▲
                                         │ POST /token cada 40 min
                              [GitHub Actions + Playwright]
                               abre smn.gob.ar y lee el token
```

| Carpeta | Qué es | Dónde corre | Costo |
|---|---|---|---|
| `web/` | La app (HTML, CSS, JS, PWA) | GitHub Pages, Netlify o cualquier hosting estático | Gratis |
| `proxy/` | Cloudflare Worker que guarda el token y llama a la API | Cloudflare Workers | Gratis (100.000 pedidos/día) |
| `token-refresher/` + `.github/workflows/` | Script Python que renueva el token | GitHub Actions | Gratis (repo público) |

El proxy además cachea respuestas (búsquedas 1 día, tiempo 10 min, pronóstico 30 min), así casi no le pega al SMN y la app responde rápido.

## 3. Puesta en marcha (paso a paso)

### 3.1 Subir el proyecto a GitHub
1. Creá un repositorio (por ejemplo `tiempo-smn`) y subí todas las carpetas tal cual.

### 3.2 Desplegar el proxy
Necesitás Node.js instalado y una cuenta gratis en Cloudflare.

```bash
cd proxy
npx wrangler login
npx wrangler kv namespace create TOKENS      # copiá el id que devuelve
# pegá ese id en wrangler.toml, en "PEGAR_ACA_EL_ID_DEL_KV"
npx wrangler secret put ADMIN_SECRET         # inventá una clave larga y guardala
npx wrangler deploy                          # te da la URL, ej: https://smn-proxy.TUUSUARIO.workers.dev
```

Probalo: abrí `https://smn-proxy.TUUSUARIO.workers.dev/health` (va a decir "sin token" hasta el paso siguiente).

### 3.3 Activar la renovación del token
En GitHub: **Settings → Secrets and variables → Actions → New repository secret**:
- `WORKER_URL` = la URL del proxy
- `ADMIN_SECRET` = la misma clave del paso anterior

Después en la pestaña **Actions** abrí "Renovar token SMN" y tocá **Run workflow**. Si sale bien, `/health` muestra "vigente". A partir de ahí corre solo cada 40 minutos.

> Si GitHub Actions no logra pasar el desafío de Cloudflare, el mismo script corre en tu PC o en el servidor de la oficina con el Programador de tareas de Windows (ver 3.5).

### 3.4 Publicar la web
1. En `web/config.js` poné la URL del proxy en `PROXY_URL`.
2. En GitHub: **Settings → Pages** → Source: *GitHub Actions*. El workflow `.github/workflows/pages.yml` publica `web/` en cada push que la modifique.
3. Opcional: en `proxy/wrangler.toml` cambiá `ALLOWED_ORIGINS` a tu dominio (ej. `https://tuusuario.github.io`) y volvé a hacer `npx wrangler deploy`.

### 3.5 Plan B: renovar el token desde tu PC
```bash
cd token-refresher
pip install -r requirements.txt
playwright install chromium
set WORKER_URL=https://smn-proxy.TUUSUARIO.workers.dev
set ADMIN_SECRET=tu-clave
python refresh_token.py
```
Programalo cada 40 minutos con el Programador de tareas.

## 4. La app

- **Buscador dinámico:** a medida que escribís (desde 2 letras, con 250 ms de pausa) muestra las localidades del SMN, resalta la coincidencia, ignora tildes y se maneja con flechas, Enter y Esc. Cancela búsquedas viejas si seguís escribiendo.
- **Mi ubicación:** botón que usa el GPS del navegador o del celular y busca la localidad más cercana.
- **Tiempo actual:** temperatura, estado, sensación térmica, humedad, viento, presión y estación de medición.
- **Pronóstico 7 días:** máxima/mínima y madrugada, mañana, tarde y noche con probabilidad de lluvia.
- **Recuerda** la última localidad y las 6 últimas búsquedas.
- **PWA:** se instala desde el navegador del celular ("Agregar a pantalla de inicio") y abre sin conexión mostrando el último dato.

Para probarla en tu PC: `cd web` y `python -m http.server 8000`, después abrí `http://localhost:8000`. Sin proxy configurado, el buscador funciona igual; el tiempo muestra un aviso.

## 5. Camino a Android

La app ya está preparada: todo el acceso a datos está en `web/api.js` y la interfaz no depende de nada del navegador de escritorio.

**Opción A — TWA (la más simple):** con la web publicada, entrás a [PWABuilder](https://www.pwabuilder.com), pegás la URL y te genera el paquete para Google Play. La app es la misma web en pantalla completa.

**Opción B — Capacitor (app nativa con la misma web):**
```bash
npm init -y
npm install @capacitor/core @capacitor/cli @capacitor/android
npx cap init "Tiempo SMN" ar.tuusuario.tiemposmn --web-dir=web
npx cap add android
npx cap open android        # abre Android Studio para compilar el APK
```
Ventaja extra: en Capacitor las llamadas HTTP nativas (`CapacitorHttp`) no tienen la restricción de CORS, así que más adelante se podría prescindir del proxy obteniendo el token dentro de la propia app.

## 6. Próximos pasos posibles
- Alertas del SMN (`/alerts/{id}` ya está en el proxy; falta mostrarlas).
- Favoritos fijados y widget de Android.
- Notificación cuando hay alerta para tu localidad.

---
Datos: Servicio Meteorológico Nacional (licencia Creative Commons 2.5 Argentina). La API no es pública ni está documentada oficialmente: el SMN puede cambiarla sin aviso.
