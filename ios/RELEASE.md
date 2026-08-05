# Subir Alta Vibra al App Store (sin Xcode)

Esto compila y sube la app a App Store Connect usando una Mac en la nube
(GitHub Actions), así que no hace falta instalar Xcode en tu laptop. Todo lo
de aquí abajo se hace con el navegador y, en un par de pasos, con la app
**Llavero de acceso / Keychain Access** que ya trae tu Mac de fábrica (no es
Xcode, es una app del sistema).

Es un ratito de trabajo la primera vez. Después de esto, para subir una
nueva versión solo hace falta un clic.

## 1. Cuenta de Apple Developer

Si no la tienes: entra a https://developer.apple.com/programs/enroll/ e
inscríbete ($99 USD/año).

Una vez adentro, entra a https://developer.apple.com/account y anota tu
**Team ID** (letras/números que aparecen en la sección "Membership details").

## 2. Crear el identificador de la app

En https://developer.apple.com/account/resources/identifiers/list :
1. "+" → "App IDs" → "App".
2. Description: `Alta Vibra`.
3. Bundle ID: **explicit**, escribe `com.altavibra.california2026` (tiene
   que ser exacto, así ya está configurado en el proyecto).
4. Capabilities: no hace falta marcar nada especial por ahora.
5. Guardar.

## 3. Crear la app en App Store Connect

En https://appstoreconnect.apple.com → Apps → "+" → "New App":
- Plataforma: iOS
- Nombre: `Alta Vibra`
- Idioma principal: Español
- Bundle ID: elige `com.altavibra.california2026` (el que acabas de crear)
- SKU: cualquier texto único, por ejemplo `altavibra2026`

Ahí mismo, cuando pida la política de privacidad, usa:
`https://california2026-production.up.railway.app/privacy.html`

## 4. Certificado de distribución (con Keychain Access, no Xcode)

1. Abre **Keychain Access** (Llavero de acceso) — está en Aplicaciones →
   Utilidades, viene con macOS.
2. Menú Keychain Access → Certificate Assistant → **Request a Certificate
   from a Certificate Authority**.
3. Pon tu correo, tu nombre, marca "Saved to disk" → Continuar. Se guarda un
   archivo `CertificateSigningRequest.certSigningRequest`.
4. Ve a https://developer.apple.com/account/resources/certificates/list →
   "+" → **Apple Distribution** → sube ese archivo → Generar → Descargar.
5. Doble clic al `.cer` descargado — se instala solo en Keychain Access.
6. Dentro de Keychain Access, busca el certificado (categoría "My
   Certificates", debe decir "Apple Distribution: Tu Nombre"), clic derecho
   → **Export** → formato `.p12` → ponle una contraseña que vas a volver a
   usar en el paso 7 (anótala).

## 5. Perfil de aprovisionamiento

En https://developer.apple.com/account/resources/profiles/list → "+":
1. Tipo: **App Store Connect** (bajo "Distribution").
2. App ID: `com.altavibra.california2026`.
3. Selecciona el certificado que acabas de crear.
4. Nombre del perfil: ponle algo simple como `AltaVibra AppStore` — vas a
   necesitar este nombre **exacto** más adelante.
5. Generar → Descargar (`.mobileprovision`).

## 6. Llave de App Store Connect API

En App Store Connect → Users and Access → pestaña **Integrations** → **App
Store Connect API** → "+":
1. Nombre: `GitHub Actions`.
2. Acceso: **App Manager**.
3. Generar → **descarga el archivo `.p8` en ese momento** (es la única vez
   que Apple te deja descargarlo).
4. Anota el **Key ID** y el **Issuer ID** que aparecen en esa pantalla.

## 7. Convertir los archivos y guardarlos como secretos en GitHub

Abre la app **Terminal** en tu Mac (tampoco es Xcode, viene con macOS) y, en
la carpeta donde tengas cada archivo descargado, corre:

```bash
base64 -i Certificates.p12 | pbcopy
```

Eso copia el resultado al portapapeles. Repite con cada archivo (cambia el
nombre): `base64 -i perfil.mobileprovision | pbcopy` y
`base64 -i AuthKey_XXXX.p8 | pbcopy`.

Luego, en GitHub: entra al repo → **Settings → Secrets and variables →
Actions → New repository secret**, y crea uno por uno (el valor es lo que
copiaste con `pbcopy`, pégalo tal cual):

| Nombre del secreto | Valor |
|---|---|
| `APPLE_TEAM_ID` | Tu Team ID (paso 1) |
| `APPLE_CERTIFICATE_P12_BASE64` | El `.p12` en base64 |
| `APPLE_CERTIFICATE_PASSWORD` | La contraseña que le pusiste al exportar el `.p12` |
| `APPLE_PROVISIONING_PROFILE_BASE64` | El `.mobileprovision` en base64 |
| `PROVISIONING_PROFILE_NAME` | El nombre exacto que le pusiste en el paso 5 |
| `APP_STORE_CONNECT_KEY_ID` | Key ID del paso 6 |
| `APP_STORE_CONNECT_ISSUER_ID` | Issuer ID del paso 6 |
| `APP_STORE_CONNECT_API_KEY_BASE64` | El `.p8` en base64 |
| `KEYCHAIN_PASSWORD` | Cualquier contraseña que tú inventes — solo la usa el robot mientras compila |

## 8. Compilar y subir

En GitHub → pestaña **Actions** → "Compilar y subir a App Store" → **Run
workflow**. Tarda unos 10-15 minutos. Cuando termine en verde, la build ya
está subida — entra a App Store Connect, sección **TestFlight**, para verla
procesada (tarda otro rato ahí Apple la procesa).

De ahí, para mandarla a revisión: en App Store Connect, sección "App
Store" de tu app, llena capturas de pantalla y descripción, selecciona la
build que subiste, y "Submit for Review".

## Para la próxima versión

Ya con todos los secretos guardados, subir una actualización es nada más
volver a correr el mismo workflow (paso 8) — no hay que repetir nada de los
pasos 1-7.
