# Deterministischer Build für Railway (umgeht Nixpacks/NODE_ENV-Fallstricke).
# Build-Kontext ist der Ordner booking-app (Railway "Root Directory" = booking-app).
FROM node:20-slim

WORKDIR /app

# Zuerst nur die Manifeste kopieren – besseres Layer-Caching
COPY package.json package-lock.json ./

# Dev-Abhängigkeiten (TypeScript) explizit installieren, auch bei NODE_ENV=production.
# --include=dev überschreibt das Weglassen von devDependencies unter production.
RUN npm ci --include=dev

# Restlichen Quellcode + Migrationen kopieren
COPY . .

# TypeScript nach dist/ kompilieren
RUN npm run build

ENV PORT=3000
EXPOSE 3000

# Beim Start: Migrationen anwenden, dann Server starten – ausschliesslich
# kompiliertes JS (kein tsx zur Laufzeit nötig).
CMD ["sh", "-c", "node dist/migrate.js && node dist/index.js"]
