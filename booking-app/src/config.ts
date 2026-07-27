import 'dotenv/config';

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Umgebungsvariable ${name} fehlt (siehe .env.example)`);
  return v;
}

export const config = {
  port: Number(process.env.PORT ?? 3000),
  databaseUrl: required('DATABASE_URL'),

  /** Shared Secret der Shopify-App: signiert App-Proxy-Requests und Webhooks */
  shopifyApiSecret: required('SHOPIFY_API_SECRET'),
  /** myshopify-Domain des Shops, z. B. fahrschule-tuerhan.myshopify.com */
  shopDomain: required('SHOPIFY_SHOP_DOMAIN'),

  /** Secret für Buchungs-Tokens und Admin-Session-Cookies (min. 32 Zeichen) */
  appSecret: required('APP_SECRET'),

  /** scrypt-Hash des Admin-Passworts, erzeugt mit: npm run migrate -- --hash-password */
  adminPasswordHash: process.env.ADMIN_PASSWORD_HASH ?? '',

  /** Öffentliche Shop-URL für Links in E-Mails, z. B. https://fahrschule-tuerhan.li */
  publicShopUrl: process.env.PUBLIC_SHOP_URL ?? `https://${process.env.SHOPIFY_SHOP_DOMAIN}`,

  /** Zusätzliche erlaubte Storefront-Domains (kommagetrennt), die den Kalender
   *  direkt aufrufen dürfen – z. B. eine spätere eigene Domain wie
   *  https://fahrschule-tuerhan.li. Die myshopify-Domain ist automatisch erlaubt. */
  storefrontOrigins: (process.env.STOREFRONT_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  smtp: {
    host: process.env.SMTP_HOST ?? '',
    port: Number(process.env.SMTP_PORT ?? 587),
    user: process.env.SMTP_USER ?? '',
    pass: process.env.SMTP_PASS ?? '',
    from: process.env.MAIL_FROM ?? '',
    operator: process.env.MAIL_OPERATOR ?? '',
  },

  nodeEnv: process.env.NODE_ENV ?? 'development',
} as const;

export const TIMEZONE = 'Europe/Zurich';
