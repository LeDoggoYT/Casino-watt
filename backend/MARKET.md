# Handelsplatz

Deployment: `app.py`, `market.py` und `loot_catalog.json` gemeinsam auf PythonAnywhere aktualisieren und im Web-Tab Reload klicken. Frontend: `index.html`, `style.css`, `script.js`, `loot.js`, `market.js` und `assets/` veröffentlichen. Bestehende Datenbanken werden beim Start automatisch erweitert; vorhandene Bestände bleiben erhalten. Vor Backend-Updates eine Datenbanksicherung anlegen.

Spielerangebote haben frei wählbare, feste Preise zwischen 0,5 und 10 Millionen Chips (0,5er-Schritte). Ein Angebot reserviert genau einen Gegenstand. Kaufen überträgt Gegenstand und Chips atomar, ohne Gebühren. Der Verkäufer kann das Angebot zurücknehmen. Schnellverkauf entfernt einen freien Gegenstand und zahlt den serverseitigen Kurs aus. Ein veralteter Kurs wird abgelehnt und neu geladen.

Die gemeinsame Preisperiode beträgt 600 Sekunden, an Unix-Zeitgrenzen ausgerichtet. Gezählt werden alle Gegenstände im Inventar aller Spieler, inklusive reservierter Angebote. Lootboxen erhöhen den Bestand, Schnellverkäufe reduzieren ihn. Spielerhandel verschiebt nur Eigentum und verändert den Gesamtbestand nicht.

Pro abgeschlossenem Intervall: Änderung = -(neuer Bestand − alter Bestand) / max(alter Bestand, 10), begrenzt auf ±10 %. Der Preis startet beim CHF-Referenzwert in Spielchips, ist auf 25–200 % dieses Startwerts begrenzt und wird auf halbe Chips gerundet (mindestens 0,5). Bei unverändertem Bestand bleibt der Preis gleich. Diese Rundung kann bei kleinen Werten die prozentuale Anzeige leicht beeinflussen. Eigene Angebotspreise und Lootboxpreise ändern sich dadurch nicht.

Die Verarbeitung erfolgt bei der nächsten Serveranfrage unter einer SQLite-Schreibtransaktion. Ausgaben und Bestandsereignisse sind persistent; bei Inaktivität werden abgeschlossene Intervalle nachgerechnet. Kein Hintergrundprozess oder Cronjob nötig. Die geöffnete Handelsseite lädt alle 10 Sekunden neu. Kurswechsel werden beim Schnellverkauf zusätzlich serverseitig geprüft.

Tests (jeweils eigener Prozess): `python -m unittest test_market -v` und `python -m unittest test_python_api -v`. Nur temporäre Testdatenbanken werden verwendet.
