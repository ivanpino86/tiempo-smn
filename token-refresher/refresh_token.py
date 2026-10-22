"""
Renueva el token del SMN y se lo manda al proxy.

El token de la API del SMN viene embebido en el HTML de www.smn.gob.ar y dura 1 hora.
Como la página tiene un desafío de Cloudflare, hace falta un navegador real:
este script usa Playwright (Chromium) para abrirla y leer el token.

Uso:
    pip install playwright requests
    playwright install chromium
    set WORKER_URL=https://smn-proxy.TU-USUARIO.workers.dev     (Windows)
    set ADMIN_SECRET=la-clave-que-cargaste-en-el-worker
    python refresh_token.py

Variables de entorno:
    WORKER_URL    URL del proxy (sin barra final)
    ADMIN_SECRET  misma clave que el secreto ADMIN_SECRET del Worker
    HEADLESS      "0" para ver el navegador (útil para depurar). Por defecto "1".
"""

import os
import re
import sys
import time

import requests
from playwright.sync_api import sync_playwright

SMN_URL = "https://www.smn.gob.ar/"
TOKEN_RE = re.compile(r"localStorage\.setItem\(\s*['\"]token['\"]\s*,\s*['\"]([A-Za-z0-9._-]+)['\"]\s*\)")


def obtener_token():
    headless = os.environ.get("HEADLESS", "1") != "0"
    with sync_playwright() as p:
        browser = p.chromium.launch(
            headless=headless,
            args=["--disable-blink-features=AutomationControlled"],
        )
        context = browser.new_context(
            user_agent=(
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
            ),
            locale="es-AR",
        )
        # Oculta la marca de "navegador automatizado"
        context.add_init_script("Object.defineProperty(navigator, 'webdriver', {get: () => undefined})")
        page = context.new_page()
        page.goto(SMN_URL, wait_until="domcontentloaded", timeout=60000)

        token = None
        # Esperamos hasta 40 s: si aparece el desafío de Cloudflare, se resuelve solo
        for _ in range(20):
            token = page.evaluate("() => localStorage.getItem('token')")
            if token:
                break
            match = TOKEN_RE.search(page.content())
            if match:
                token = match.group(1)
                break
            time.sleep(2)

        browser.close()
        return token


def enviar_al_proxy(token):
    worker = os.environ["WORKER_URL"].rstrip("/")
    secret = os.environ["ADMIN_SECRET"]
    r = requests.post(
        worker + "/token",
        json={"token": token},
        headers={"Authorization": "Bearer " + secret},
        timeout=30,
    )
    print("Proxy respondió:", r.status_code, r.text)
    return r.ok


def main():
    token = obtener_token()
    if not token:
        print("No se pudo obtener el token (¿Cloudflare bloqueó el acceso?). Probá con HEADLESS=0.")
        sys.exit(1)
    print("Token obtenido:", token[:20] + "...")
    if not enviar_al_proxy(token):
        sys.exit(2)


if __name__ == "__main__":
    main()
