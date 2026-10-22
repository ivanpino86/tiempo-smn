// Configuración de la app. Es lo único que tenés que tocar al desplegar.
window.SMN_CONFIG = {
  // URL de tu proxy en Cloudflare Workers (sin barra final).
  // Ejemplo: "https://smn-proxy.ivanpino.workers.dev"
  PROXY_URL: "https://smn-proxy.ivanpino86.workers.dev",

  // La búsqueda de localidades del SMN es abierta: la app la llama directo
  // y usa el proxy solo si falla. Poné false para pasar todo por el proxy.
  DIRECT_SEARCH: true,
};
