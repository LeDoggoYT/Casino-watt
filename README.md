# Watt Casino

Kostenloses Blackjack mit virtuellem Spielgeld. Die Oberfläche ist eine statische Vanilla-JavaScript-Anwendung; Authentifizierung, Karten, Kontostände, Auszahlungen, Statistiken und Rangliste werden ausschließlich vom separaten Node.js-Server berechnet.

## Ordnerstruktur

```text
Casino Watt/
├── index.html                 # Statisches Frontend
├── style.css
├── script.js                  # API_URL zentral konfigurieren
├── README.md
└── backend/
    ├── .env.example
    ├── package.json
    ├── src/
    │   ├── server.js
    │   ├── db.js              # SQLite-Schema und Initialisierung
    │   ├── blackjack.js
    │   ├── game-service.js
    │   └── routes/
    └── test/
```

## Ohne Railway: auf dem eigenen PC oder Server starten

Das Backend ist jetzt vollständig eigenständig. Es benötigt nur Node.js 20+ oder Docker; Railway wird nicht verwendet.

### Lokal auf dem eigenen PC

1. In PowerShell:

   ```powershell
   cd "C:\Users\lolac\Documents\Casino Watt\backend"
   Copy-Item .env.example .env
   npm install
   npm run dev
   ```

2. In einem zweiten Terminal das Frontend starten:

   ```powershell
   cd "C:\Users\lolac\Documents\Casino Watt"
   python -m http.server 8080 --bind 127.0.0.1
   ```

3. Öffne `http://127.0.0.1:8080`. Die Frontend-Dateien zeigen bereits auf `http://127.0.0.1:3000`; Registrierung, Blackjack, Adminbereich und Leaderboard funktionieren damit direkt auf diesem PC.

Der Adminbereich ist lokal unter `http://127.0.0.1:8080/admin/` erreichbar. Das lokale Passwort stammt aus `backend/.env`.

### Eigener VPS oder eigener Rechner als öffentlicher Server

Für die bereits veröffentlichte Netlify-Seite muss die API über **deine eigene HTTPS-Domain** erreichbar sein. Eine lokale `127.0.0.1`-Adresse kann Netlify nicht erreichen.

Voraussetzungen: eine Domain (z. B. `api.deine-domain.de`), ein Rechner/VPS mit öffentlicher IPv4-Adresse, Docker und freie Ports 80/443. Leite den DNS-A-Record der API-Domain auf die öffentliche IP des Rechners.

1. Repository auf den Server kopieren oder klonen.
2. `backend/.env` aus der Vorlage anlegen und mindestens diese Werte setzen:

   ```dotenv
   NODE_ENV=production
   ADMIN_PASSWORD=2011
   API_DOMAIN=api.deine-domain.de
   FRONTEND_ORIGINS=https://wigipedia.netlify.app
   ```

   Verwende in der Praxis ein deutlich längeres, eigenes Admin-Passwort.

3. Im Projektordner starten:

   ```bash
   docker compose --profile public up -d --build
   ```

   Docker speichert die SQLite-Datenbank dauerhaft im Volume `watt_casino_data`. Caddy stellt die API mit automatischem HTTPS-Zertifikat bereit.

4. Prüfe danach `https://api.deine-domain.de/health`. Es muss `"success":true` zurückgeben.
5. Ersetze in **beiden** Dateien `script.js` und `admin/admin.js` die Konstante durch dieselbe eigene HTTPS-Adresse und veröffentliche das Frontend erneut:

   ```js
   const API_URL = "https://api.deine-domain.de";
   ```

Die API-Domain ist öffentlich und kein Geheimnis. Passwörter sowie die Datei `backend/.env` bleiben ausschließlich auf deinem PC/Server.

## Umgebungsvariablen

| Variable | Zweck | Standard |
| --- | --- | --- |
| `HOST` | Bind-Adresse der API (`127.0.0.1` lokal, `0.0.0.0` im Container) | `127.0.0.1` |
| `PORT` | HTTP-Port der API | `3000` |
| `NODE_ENV` | Laufzeitmodus | `development` |
| `FRONTEND_ORIGINS` | erlaubte CORS-Ursprünge, kommasepariert | Produktivseite und lokale Beta |
| `DATABASE_PATH` | SQLite-Datei relativ zu `backend/` | `./data/watt-casino.sqlite` |
| `SESSION_DAYS` | Gültigkeit einer Anmeldung | `30` |
| `BCRYPT_ROUNDS` | bcrypt-Kostenfaktor | `12` |
| `TRUST_PROXY` | Anzahl vertrauenswürdiger Reverse-Proxies | `0` |
| `ADMIN_PASSWORD` | Passwort für den nicht verlinkten Bereich `/admin/` | lokal `2011` |
| `API_DOMAIN` | eigene API-Domain für Caddy/Docker | kein Standard |

Beim ersten Serverstart werden Datenbank, Tabellen und Indizes automatisch erstellt.

## Adminbereich

Der Adminbereich ist bewusst nirgendwo in der Anwendung verlinkt und wird direkt über `/admin/` aufgerufen. Das Passwort wird ausschließlich von der API geprüft.

Im Adminbereich können Guthaben und Benutzernamen geändert sowie Konten mit einer sichtbaren Begründung gesperrt und entsperrt werden. Alle Änderungen werden serverseitig in `admin_audit_log` protokolliert. Eine Guthabenänderung ist während einer aktiven Blackjack-Runde gesperrt, damit keine inkonsistenten Auszahlungen entstehen.

## Sicherheits- und Spiellogik

- Passwörter liegen ausschließlich bcrypt-gehasht vor.
- Browser erhalten einen zufälligen Session-Token; in SQLite wird davon nur ein SHA-256-Hash gespeichert.
- Der Server mischt den Kartenschlitten, validiert Einsätze, verwaltet aktive Runden und berechnet jede Auszahlung.
- Jede verändernde Spielaktion benötigt eine eindeutige `actionId`. SQLite-Transaktionen und ein Unique-Index verhindern doppelte Auszahlungen.
- Kontostände haben eine Datenbank-`CHECK`-Regel gegen negative Werte.
- Die Rangliste liefert maximal 100 Spieler pro Seite.
- Spielzeit wird nur durch aktive, zeitlich begrenzte Server-Heartbeats gutgeschrieben. Unsichtbare oder inaktive Tabs erzeugen keine unbegrenzte Spielzeit.

## Tests

```powershell
cd "C:\Users\lolac\Documents\Casino Watt\backend"
npm test
```
