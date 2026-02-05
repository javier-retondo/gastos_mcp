# Gastos MCP

App mínima para subir comprobantes desde el celular, guardarlos en una carpeta local (`pendientes/`) y disparar el procesamiento con Codex.  
Los registros se cargan en Notion siguiendo las reglas documentadas en `AGENTS.md`.

## Objetivo
- Subir archivos + descripción desde una interfaz web simple.
- Si no hay archivo, crear un `.txt` con la descripción.
- Guardar todo en `pendientes/` con nombre seguro.
- Ejecutar un comando de Codex para procesar todo el lote.

## Requisitos
- Docker + Docker Compose (en servidor o local).
- Credenciales de Codex (login interactivo dentro del contenedor).

## Estructura
```
.
├─ Dockerfile
├─ docker-compose.yml
├─ server.js
├─ public/
│  └─ index.html
├─ pendientes/    # entrada
├─ procesados/    # salida
├─ codex-home/    # persistencia de login Codex
└─ AGENTS.md
```

## Variables de entorno
Crear `.env` con lo siguiente:
```
JWT_SECRET=pon-una-clave-fuerte
JWT_EXPIRES_IN=30d
ADMIN_PASSWORD_HASH=<hash bcrypt>
CODEX_PROMPT=<prompt fijo para procesar carpeta>
```

Generar el hash de password:
```
npm run hash:pass -- "tu-password"
```

## Ejecutar con Docker
```
docker compose up -d --build
```

Interfaz web:
```
http://<tu-ip-o-dominio>:3000
```

## Login (Codex)
Dentro del contenedor, se instala `@openai/codex`.  
El login queda persistido en `./codex-home`.

Si necesitás login interactivo, podés entrar con:
```
docker exec -it gastos_mcp bash
codex login
```

### Login en VPS (headless)
Si estás en un servidor sin navegador, usá device code:
```
docker exec -it gastos_mcp bash
codex login --device-auth
```
Luego abrís el link en tu navegador local e ingresás el código.  
Este flujo está soportado por Codex CLI para entornos headless. citeturn0search0

## Flujo de uso
1. Abrís la web.
2. Logueás con la contraseña del admin.
3. Subís archivo + descripción (o solo descripción).
4. Presionás “Procesar”.

Resultado:
- Archivo en `pendientes/`.
- Codex procesa lote.
- Archivo se mueve a `procesados/`.

## Endpoints
- `POST /api/auth/login` -> devuelve JWT
- `POST /api/upload` -> sube archivo o crea `.txt`
- `POST /api/process` -> ejecuta Codex
- `GET /api/health` -> healthcheck
- `GET /api/status` -> estado básico

## Seguridad
Este repo es **público**.  
Recomendado:
- No subir `.env` ni credenciales.
- Usar contraseña fuerte.
- Mantener `JWT_SECRET` fuera del repo.

## Notas
- OCR disponible dentro del contenedor (`tesseract` + `pdftotext`).
- No se crean categorías ni cuentas nuevas (según reglas de `AGENTS.md`).
