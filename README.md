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

## Lokal starten

Voraussetzung: Node.js 20 oder neuer und Python 3 (oder ein anderer statischer Webserver).

1. API konfigurieren und starten:

   ```powershell
   cd "C:\Users\lolac\Documents\Casino Watt\backend"
   Copy-Item .env.example .env
   npm install
   npm run dev
   ```

2. In einem zweiten Terminal das Frontend bereitstellen:

   ```powershell
   cd "C:\Users\lolac\Documents\Casino Watt"
   python -m http.server 8080 --bind 127.0.0.1
   ```

3. `http://127.0.0.1:8080` im Browser öffnen.

Die lokale Standardkonfiguration passt zusammen:

```text
Frontend: http://127.0.0.1:8080
API:      http://127.0.0.1:3000
```

## Domains konfigurieren

Die API erlaubt CORS ausschließlich für eine feste Frontend-Domain. Setze im Backend in `backend/.env`:

```dotenv
FRONTEND_ORIGIN=https://casino.example.com
```

Setze anschließend im Frontend in `script.js` dieselbe veröffentlichte API-Adresse:

```js
const API_URL = "https://api.example.com";
```

Für lokale Entwicklung bleiben die beiden Standardwerte aus `.env.example` und `script.js` passend. Für die Produktion müssen beide Adressen HTTPS verwenden. Die API-Domain gehört nie in einen geheimen Schlüssel; sie ist öffentlich. Zugangsdaten, Passwörter und Servergeheimnisse werden nicht im Frontend abgelegt.

## Umgebungsvariablen

| Variable | Zweck | Standard |
| --- | --- | --- |
| `PORT` | HTTP-Port der API | `3000` |
| `NODE_ENV` | Laufzeitmodus | `development` |
| `FRONTEND_ORIGIN` | einzig erlaubter CORS-Ursprung | erforderlich |
| `DATABASE_PATH` | SQLite-Datei relativ zu `backend/` | `./data/watt-casino.sqlite` |
| `SESSION_DAYS` | Gültigkeit einer Anmeldung | `30` |
| `BCRYPT_ROUNDS` | bcrypt-Kostenfaktor | `12` |
| `TRUST_PROXY` | Anzahl vertrauenswürdiger Reverse-Proxies | `0` |
| `ADMIN_PASSWORD` | Passwort für den nicht verlinkten Bereich `/admin/` | lokal `2011` |

Beim ersten Serverstart werden Datenbank, Tabellen und Indizes automatisch erstellt.

## Adminbereich

Der Adminbereich ist bewusst nirgendwo in der Anwendung verlinkt und wird direkt über `/admin/` aufgerufen. Das Passwort wird ausschließlich von der API geprüft. Für Railway muss vor dem Deployment diese Variable gesetzt werden:

```dotenv
ADMIN_PASSWORD=2011
```

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
