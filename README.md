# Watt Casino

Kostenloses Blackjack mit virtuellem Spielgeld. Das Frontend verwendet jetzt eine vollständige Python-/Flask-API. Alle bisherigen API-Endpunkte, Login, Sessions, Blackjack, Leaderboard, Statistiken und der Adminbereich bleiben erhalten.

## Python-Backend

- `backend/app.py`: vollständige Flask-API
- `backend/wsgi.py`: WSGI-Einstiegspunkt
- `backend/pythonanywhere_wsgi.py.example`: Vorlage für die PythonAnywhere-WSGI-Datei
- `backend/requirements.txt`: Flask und bcrypt
- `backend/test_python_api.py`: Integrationstest

Die alte Node-/Express-Implementierung wurde entfernt. Das Frontend braucht keine API-Änderungen.

## Lokal starten

Voraussetzung: Python 3.10 oder neuer.

    cd "C:\Users\lolac\Documents\Casino Watt\backend"
    Copy-Item .env.example .env
    py -3 -m pip install -r requirements.txt
    py -3 app.py

In einem zweiten Terminal:

    cd "C:\Users\lolac\Documents\Casino Watt"
    py -3 -m http.server 8080 --bind 127.0.0.1

Danach `http://127.0.0.1:8080` öffnen. Die lokale API-Adresse in `script.js` und `admin/admin.js` ist bereits `http://127.0.0.1:3000`.

## Auf PythonAnywhere bereitstellen

1. Erstelle einen PythonAnywhere-Account und öffne eine Bash Console.
2. Repository und Abhängigkeiten einrichten:

    git clone https://github.com/LeDoggoYT/Casino-watt.git Casino-Watt
    cd ~/Casino-Watt/backend
    python3.13 -m pip install --user -r requirements.txt
    cp .env.example .env

3. Bearbeite `~/Casino-Watt/backend/.env` mit:

    NODE_ENV=production
    DATABASE_PATH=/home/DEIN_PYTHONANYWHERE_NAME/Casino-Watt/backend/data/watt-casino.sqlite
    FRONTEND_ORIGINS=https://wigipedia.netlify.app
    ADMIN_PASSWORD=2011

Vor einer öffentlichen Veröffentlichung muss ein längeres eigenes Admin-Passwort gesetzt werden.

4. Unter Web: Add a new web app → Manual configuration → Python 3.13.
5. Öffne die erzeugte WSGI-Datei. Ersetze ihren Inhalt durch `backend/pythonanywhere_wsgi.py.example`; darin `DEIN_PYTHONANYWHERE_NAME` durch deinen Account-Namen ersetzen.
6. Klicke Reload und prüfe `https://DEIN_PYTHONANYWHERE_NAME.pythonanywhere.com/health`.
7. Ändere danach in **beiden** Dateien `script.js` und `admin/admin.js`:

    const API_URL = "https://DEIN_PYTHONANYWHERE_NAME.pythonanywhere.com";

8. Push diese Frontend-Änderung zu GitHub, damit Netlify die neue API-Domain verwendet.

Die SQLite-Datei liegt im Home-Verzeichnis des PythonAnywhere-Accounts und bleibt bei Web-App-Reloads erhalten.

## Umgebungsvariablen

- `NODE_ENV`: auf PythonAnywhere `production`
- `FRONTEND_ORIGINS`: erlaubte Frontend-Domains, kommasepariert
- `DATABASE_PATH`: SQLite-Pfad, auf PythonAnywhere absolut
- `SESSION_DAYS`: Laufzeit der Spielersitzung, Standard 30
- `BCRYPT_ROUNDS`: bcrypt-Kostenfaktor, Standard 12
- `ADMIN_PASSWORD`: Passwort für `/admin/`

## Test

    cd "C:\Users\lolac\Documents\Casino Watt\backend"
    py -3 -m unittest -v test_python_api.py
