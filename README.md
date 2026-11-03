# Watt Casino

Kostenloses Blackjack mit virtuellem Spielgeld. Das Frontend verwendet jetzt eine vollständige Python-/Flask-API. Alle bisherigen API-Endpunkte, Login, Sessions, Blackjack, Leaderboard, Statistiken und der Adminbereich bleiben erhalten.

## Python-Backend

- `backend/app.py`: vollständige Flask-API
- `backend/wsgi.py`: WSGI-Einstiegspunkt
- `backend/pythonanywhere_wsgi.py.example`: Vorlage für die PythonAnywhere-WSGI-Datei
- `backend/requirements.txt`: Flask und bcrypt
- `backend/test_python_api.py`: Integrationstest

Die alte Node-/Express-Implementierung wurde entfernt. Das Frontend braucht keine API-Änderungen.

## Serverlast

Der laufende Spielzustand bleibt absichtlich serverseitig, damit Browser weder Karten noch Guthaben manipulieren können. Die API ist dennoch auf kleine Hosting-Tarife optimiert:

- Profil und laufende Runde werden beim Login gemeinsam geladen.
- Die Rangliste aktualisiert sich nur alle 30 Sekunden und pausiert in Hintergrund-Tabs.
- Aktivität wird alle zwei Minuten statt alle 30 Sekunden übertragen.
- Sitzungs-Zeitstempel werden höchstens alle fünf Minuten geschrieben.
- Abgelaufene Datensätze werden höchstens alle 15 Minuten statt bei jeder Anfrage bereinigt.

Damit sinken vor allem die für SQLite teuren Schreibzugriffe sowie die dauerhaften Hintergrundanfragen deutlich; Spielaktionen bleiben serverseitig verbindlich.

## Poker

Poker ist ein Online-Tisch für zwei Spieler. Der Host gibt der Lobby einen Namen; andere Spieler wählen sie aus der Liste offener Lobbys. Beide zahlen zu Beginn 10 virtuelle Chips. Pro Phase können Spieler die nächste Gemeinschaftskarte anfordern, mitgehen, in 0,5-Chip-Schritten um mindestens 5 Chips erhöhen oder passen. Eine Erhöhung ist auf den von beiden Spielern deckbaren Betrag begrenzt. Karten, Zugfolge, Pot, Handrang und Auszahlung werden auf dem Server berechnet. Die Hand-Rangfolgen-Grafik steht links neben dem Tisch.

## Mines

Mines hat ein 5×5-Spielfeld mit 1 bis 20 wählbaren Minen. Der Einsatz wird mit denselben Chips wie bei den anderen Spielen gesetzt. Nach jedem sicheren Feld kann der Gewinn ausgezahlt werden; eine Mine beendet die Runde ohne Auszahlung. Minenpositionen, laufende Runden und das letzte Ergebnis werden auf dem Server gespeichert. Der Auszahlungsfaktor basiert auf der Überlebenswahrscheinlichkeit mit 3 % Hausvorteil und wird auf halbe Chips abgerundet.

## Upgrades und Einsätze

Spieler können im Bereich **Upgrades** Chips in sieben dauerhafte Verbesserungen investieren: Startkapital, Glück, Blackjack-Bonus, Verlustschutz, Serienbonus, Doppel-Profi und Tagesbonus. Käufe, Level, Tagesbonus und alle Auswirkungen auf Auszahlungen werden serverseitig gespeichert und berechnet. Jedes Upgrade besitzt fünf Level; der Preis verdoppelt sich nach jedem Kauf.

Neben den festen Chips gibt es einen 1.000er-Chip und einen frei wählbaren Betrag. Eigene Einsätze müssen mindestens 5 Chips betragen, dürfen das verfügbare Guthaben nicht überschreiten und werden auf halbe Chips gerundet.

Die Anmeldung bleibt im Browser gespeichert und verlängert sich bei aktiver Nutzung automatisch um weitere 30 Tage. Kurzzeitige Verbindungsfehler löschen die Sitzung nicht mehr; das Frontend versucht die Verbindung automatisch erneut aufzubauen. Nur Abmelden, eine Kontosperre oder eine tatsächlich abgelaufene/ungültige Sitzung entfernt das lokale Sitzungstoken.

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

Das Admin-Panel unter `/admin/` verwendet die normale Spielersitzung. Das bestehende Spielerkonto `Tiago` hat vollen Zugriff; Moderatoren werden über die Spielersuche ausgewählt und ihre Rechte dort verwaltet. Das Recht „Nur eigenes Guthaben ändern“ zeigt dem Moderator nur sein Konto und erlaubt keine Änderungen an anderen Guthaben. Tiagos Spielerpasswort sollte sicher und nur ihm bekannt sein.

Beim Sperren eines Kontos werden dessen bekannte IP-Adressen ebenfalls gesperrt; von diesen Adressen sind dann auch neue Registrierungen und Logins blockiert. Das Aufheben der Kontosperre entfernt die zugehörigen IP-Sperren. Tiago kann ein Spielerkonto vollständig löschen, einschließlich Spielstand, Sitzungen, Profilbild und zugehöriger IP-Sperren. Bereits bestehende Konten haben erst dann eine bekannte IP-Adresse, wenn sie nach dem Update wieder eine Anfrage senden. Andere Anschlüsse oder VPNs können eine IP-Sperre umgehen; gemeinsam genutzte Anschlüsse können weitere Spieler betreffen.

4. Unter Web: Add a new web app → Manual configuration → Python 3.13.
5. Öffne die erzeugte WSGI-Datei. Ersetze ihren Inhalt durch `backend/pythonanywhere_wsgi.py.example`; darin `DEIN_PYTHONANYWHERE_NAME` durch deinen Account-Namen ersetzen.
6. Klicke Reload und prüfe `https://DEIN_PYTHONANYWHERE_NAME.pythonanywhere.com/health`.

Lokale Frontends auf `127.0.0.1` oder `localhost` mit Port 5501 oder 8080 sind zusätzlich erlaubt. Nach Backend-Änderungen auf PythonAnywhere `git pull` ausführen und die Web-App unter **Web → Reload** neu laden; sonst antwortet weiterhin die alte API-Version.
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

## Test

    cd "C:\Users\lolac\Documents\Casino Watt\backend"
    py -3 -m unittest -v test_python_api.py
