# Trap University — Dashboard de proyección de ventas (app alojada)

Dashboard web con URL propia que muestra la proyección de ventas del día y del mes de la tienda, con datos **exactos de WooCommerce**, y publica un resumen en **Slack 2 veces al día**.

- Ventas del día y del mes: **WooCommerce** (mismo número que tu admin).
- Tráfico y conversión: **Google Analytics 4** (opcional).
- Abandono de checkout: **Klaviyo** (opcional).
- Modelo de proyección: curva intradía verificada (hora Pacífico), factores por día de semana y día del mes (quincena/cierre), meta diaria de $1.000.

La app funciona aunque falten conectores: sin WooCommerce entra en "modo demo" (ventas en 0) hasta que pegues las credenciales.

---

## Requisitos previos (credenciales, todo de solo lectura)

1. **WooCommerce** (obligatorio): en el admin → WooCommerce → Settings → Advanced → REST API → *Add key*. Permisos **Read**. Copia `Consumer key`, `Consumer secret` y la URL del sitio. No requiere plugins.
2. **Klaviyo** (opcional): Account → Settings → API Keys → crea una *Private API Key* de solo lectura.
3. **Google Analytics 4** (opcional): crea una *cuenta de servicio* en Google Cloud, descarga su JSON, y en GA4 → Admin → Property Access agrega el `client_email` como Lector. Anota el `Property ID` (numérico).
4. **Slack**: en la app de Slack → crea un *Incoming Webhook* para el canal donde quieres el resumen. Copia la URL.

---

## Despliegue en Render (gratis)

1. Sube esta carpeta a un repositorio de GitHub (o usa "Deploy from Git" de Render).
2. En Render: **New → Web Service**, conecta el repo. Render detecta `render.yaml` (build `npm install`, start `npm start`).
3. En **Environment**, pega las variables (ver `.env.example`):
   - `WOO_URL`, `WOO_KEY`, `WOO_SECRET` (obligatorias)
   - `KLAVIYO_API_KEY`, `GA_PROPERTY_ID`, `GA_SA_JSON` (opcionales)
   - `SLACK_WEBHOOK_URL`, `DASHBOARD_URL` (la URL que te da Render, ej. `https://trapu-proyeccion.onrender.com`), `CRON_TOKEN` (una palabra secreta)
   - `STORE_TZ=America/Los_Angeles`, `DAILY_GOAL=1000`
4. Deploy. La URL pública que te da Render **es el dashboard** — cualquiera con el enlace lo abre (acceso público, como pediste).

> Nota: el plan gratis de Render "duerme" el servicio tras inactividad; la primera carga puede tardar ~30s y luego va fluido.

---

## Envío 2x/día a Slack (10:00 y 15:00 PT)

El plan gratis de Render no incluye cron, así que se usa un **cron externo gratuito** que llama a un endpoint de la app:

1. Entra a un servicio gratis como **cron-job.org** (o GitHub Actions).
2. Crea dos trabajos que hagan `GET` a:
   `https://TU-URL.onrender.com/tasks/slack?token=EL_CRON_TOKEN`
3. Horarios (hora Pacífico): **10:00** y **15:00**. En cron-job.org puedes fijar la zona horaria a America/Los_Angeles directamente.

Cada llamada calcula el snapshot y publica el resumen en Slack, con un enlace que abre el dashboard.

Para probarlo manualmente: abre esa URL con el token en el navegador; deberías ver `ok` y el mensaje en Slack.

---

## Correr en local (opcional)

```bash
cp .env.example .env      # y rellena las variables
npm install
npm start                 # http://localhost:3000
npm run slack             # envía una vez a Slack (prueba)
```

---

## Notas del dato de ventas
- El dashboard usa `total_sales` de WooCommerce (bruto, como el "Total sales" del reporte). Si tu referencia es "Net sales", el backend también lo trae (`net_sales`) y se puede cambiar en `server.js`.
- Todo se calcula en **hora Pacífico** (la tienda está en California), para que los cortes de día coincidan con tu admin.
