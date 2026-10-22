# Tiempo SMN

Web app (PWA) para consultar el tiempo actual y el pronóstico de 5 días de cualquier localidad argentina con datos abiertos del Servicio Meteorológico Nacional. Funciona en cualquier navegador, se puede instalar en el celular y está pensada para empaquetarse después como app de Android.

---

## 1. De dónde salen los datos

La API de `ws1.smn.gob.ar` pide un token JWT que solo se consigue desde `www.smn.gob.ar`, protegido por un desafío de Cloudflare que bloquea a los navegadores automatizados. Por eso la app **no usa esa API** para el tiempo y el pronóstico: usa los archivos de datos abiertos del SMN, que no requieren token ni desafío.

Base: `https://ssl.smn.gob.ar/dpd/descarga_opendata.php?file=<ruta>`

| Archivo (`<ruta>`) | Contenido | Actualización |
|---|---|---|
| `observaciones/estaciones_smn.txt` | Lista de estaciones: nombre, provincia, latitud, longitud, altura, número WMO, OACI | Estática |
| `observaciones/tiepreAAAAMMDD.txt` | Última observación de cada estación (estado, visibilidad, temperatura, sensación, humedad, viento, presión), separada por `;` | Cada hora |
| `pron5d/pronAAAAMMDD.txt` | Pronóstico de modelo numérico a 5 días, cada 3 horas, por estación: temperatura, viento (dirección y km/h) y precipitación (mm) | Diaria |

Cosas a tener en cuenta:
- Los archivos pueden venir en UTF-8 o en ISO-8859-1; el parser prueba UTF-8 y, si falla, cae a latin1.
- Las fechas del nombre de archivo y los horarios son de Argentina (UTC-3, sin horario de verano). Si el archivo de hoy todavía no existe, se usa el de ayer.
- Los tres archivos **no comparten un identificador**: el mismo lugar se llama `CORDOBA OBSERVATORIO`, `Córdoba Observatorio` y `CORDOBA_OBSERVATORIO`. Se resuelve con una tabla de estaciones (ver 2).
- El pronóstico es salida de un modelo numérico: no trae descripción del cielo ni probabilidad de lluvia, solo milímetros. La app muestra temperatura, viento y lluvia en mm.
- El último paso del pronóstico a veces trae valores absurdos de precipitación (por ejemplo `850.0`); el parser los descarta.
- La búsqueda de localidades (`https://ws1.smn.gob.ar/v1/georef/location/search?name=...`) sigue siendo abierta y la app la llama directo. Cada resultado trae el número WMO de su estación y las coordenadas.

## 2. Arquitectura

```
 [App web / Android] ── búsqueda ─────────────►  ws1.smn.gob.ar  (abierta)
        │
        └── tiempo / pronóstico ─► [Proxy: Cloudflare Worker] ─► ssl.smn.gob.ar (datos abiertos)
              (wmo + lat/lon)         parsea, cachea y elige la estación
```

| Carpeta | Qué es | Dónde corre | Costo |
|---|---|---|---|
| `web/` | La app (HTML, CSS, JS, PWA) | GitHub Pages, Netlify o cualquier hosting estático | Gratis |
| `proxy/` | Cloudflare Worker que lee los archivos abiertos y responde JSON | Cloudflare Workers | Gratis (100.000 pedidos/día) |

El proxy es necesario porque los archivos abiertos son de texto plano, sin CORS y en formatos distintos entre sí; el Worker los convierte a JSON con la misma forma que usaba la API del SMN, así la interfaz casi no cambia.

**Rutas del proxy** (todas `GET`):

| Ruta | Respuesta |
|---|---|
| `/weather?wmo=&lat=&lon=` | Tiempo actual de la estación: temperatura, sensación, humedad, presión, visibilidad, descripción, viento, estación y distancia |
| `/forecast?wmo=&lat=&lon=` | 5 días: máxima, mínima, lluvia total y franjas de madrugada, mañana, tarde y noche (temperatura, viento y lluvia de 6 h en mm) |
| `/coord?lat=&lon=` | Estación con observación más cercana, con la forma de una fila de búsqueda (para "Mi ubicación") |
| `/search?q=` | Pasa la búsqueda a la API abierta del SMN (la app la llama directo y usa esta ruta solo si falla) |
| `/health` | Fechas de los archivos en uso |

**Cómo elige la estación:** si el `wmo` de la localidad corresponde a una estación con el dato pedido (observación o pronóstico), usa esa. Si no, usa la más cercana a `lat`/`lon` (distancia de Haversine) que tenga el dato. Las observaciones de más de 6 horas solo se usan si no hay otra más reciente. Entrada inválida responde `400`; si el SMN no responde, `502`.

**Caché:** el Worker guarda en la caché de Cloudflare el JSON ya parseado de cada archivo (no por estación): observaciones 10 minutos, pronóstico 60 minutos. Si el archivo de hoy aún no existe, lo recuerda 5 minutos para no insistir.

**Tabla de estaciones:** `proxy/src/stations.js` se genera con un script que baja los tres archivos y empareja cada estación con su nombre en observaciones y en pronóstico por nombre normalizado (sin tildes, mayúsculas, sin `_` ni puntuación), primero exacto y después ignorando `AERO`/`OBS`/`OBSERVATORIO`, más una lista chica de excepciones (`OVERRIDES`). Los nombres que no se emparejan se imprimen por consola. Para regenerarla:

```bash
node proxy/scripts/build-stations.mjs
```

Conviene hacerlo si el SMN agrega o renombra estaciones, y commitear el resultado.

**Tests** (Node 22, sin dependencias; los archivos de ejemplo están en `proxy/test/fixtures/`):

```bash
node --test "proxy/test/*.test.js"      # desde la raíz del repo
# o, dentro de proxy/:  npm test
```

## 3. Puesta en marcha (paso a paso)

### 3.1 Subir el proyecto a GitHub
1. Creá un repositorio (por ejemplo `tiempo-smn`) y subí todas las carpetas tal cual.

### 3.2 Desplegar el proxy
Necesitás Node.js instalado y una cuenta gratis en Cloudflare. No hace falta KV, secretos ni tokens.

```bash
cd proxy
npx wrangler login
npx wrangler deploy        # te da la URL, ej: https://smn-proxy.TUUSUARIO.workers.dev
```

Probalo: abrí `https://smn-proxy.TUUSUARIO.workers.dev/health` (debe devolver `"ok": true` y las fechas de los archivos) y `https://smn-proxy.TUUSUARIO.workers.dev/weather?wmo=87345&lat=-31.3988&lon=-64.2075` (Córdoba).

### 3.3 Publicar la web
1. En `web/config.js` poné la URL del proxy en `PROXY_URL`.
2. En GitHub: **Settings → Pages** → Source: *GitHub Actions*. El workflow `.github/workflows/pages.yml` publica `web/` en cada push que la modifique.
3. Opcional: en `proxy/wrangler.toml` cambiá `ALLOWED_ORIGINS` a tu dominio (ej. `https://tuusuario.github.io`) y volvé a hacer `npx wrangler deploy`.

## 4. La app

- **Buscador dinámico:** a medida que escribís (desde 2 letras, con 250 ms de pausa) muestra las localidades del SMN, resalta la coincidencia, ignora tildes y se maneja con flechas, Enter y Esc. Cancela búsquedas viejas si seguís escribiendo.
- **Mi ubicación:** botón que usa el GPS del navegador o del celular y busca la estación con datos más cercana.
- **Tiempo actual:** temperatura, estado, sensación térmica (cuando el SMN la calcula), humedad, viento, presión y estación de medición con su distancia.
- **Pronóstico 5 días:** máxima/mínima y madrugada, mañana, tarde y noche con temperatura, viento y lluvia en mm.
- **Recuerda** la última localidad y las 6 últimas búsquedas. Si una localidad guardada no tiene ubicación, la app pide buscarla de nuevo.
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
Ventaja extra: en Capacitor las llamadas HTTP nativas (`CapacitorHttp`) no tienen la restricción de CORS, así que más adelante se podría prescindir del proxy y leer los archivos abiertos desde la propia app (la lógica de lectura está en `proxy/src/opendata.js` y no depende de Cloudflare).

## 6. Próximos pasos posibles
- Alertas del SMN (requieren la API con token, hoy no disponible; habría que buscar una fuente abierta).
- Favoritos fijados y widget de Android.
- Mostrar el pronóstico por hora (los datos cada 3 horas ya están en el proxy).

---
Datos: Servicio Meteorológico Nacional (licencia Creative Commons 2.5 Argentina), publicados como datos abiertos. Los formatos de los archivos no están documentados oficialmente: el SMN puede cambiarlos sin aviso (los tests con archivos reales ayudan a detectarlo).
