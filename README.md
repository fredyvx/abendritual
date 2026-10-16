# Abendritual

Ein Abendritual, das dir hilft, den Kopf zu leeren und in den Schlaf zu finden. Es dauert etwa 8–10 Minuten:

1. **Ablegen**: aufschreiben, was dir durch den Kopf geht.
2. **Sortieren** in drei Stapel: *Morgen erledigen*, *Nicht heute Abend*, *Nur ein Gedanke*.
3. **Ein guter Moment**: eine Zeile dazu, was heute gut war.
4. **Meditation**: deine Sprachaufnahme, Hintergrundmusik und ein Mond, der mit dir atmet.

Die Liste „Morgen erledigen“ erscheint am nächsten Tag auf der Startseite.

## Starten

Doppelklick auf `start.bat`. Der Browser öffnet sich dann auf http://localhost:8000.
Dafür muss Python installiert sein. Das Fenster mit dem Server muss offen bleiben, solange du die App benutzt.

## Gemini (Sortieren)

1. Hol dir einen kostenlosen Schlüssel auf https://aistudio.google.com unter „Get API key“ → „Create API key“.
2. Am PC: Trag ihn in `config.local.js` ein. Auf dem Handy: in der App unter **Einstellungen**.

Ohne Schlüssel sortierst du selbst. Das klappt genauso gut.
Der Schlüssel wird nur in deinem Browser gespeichert.

Wichtig: Im Gratis-Tarif darf Google eingegebene Texte zur Verbesserung seiner Produkte nutzen. Bei sehr privaten Gedanken stellst du in den Einstellungen auf „Ich sortiere selbst“.

## Konto & Speichern

Ohne Konto liegen deine Liste und deine guten Momente nur im Browser des jeweiligen Geräts. Mit Konto sind sie sicher gespeichert und auf allen Geräten gleich. Dein Gedanken-Text wird nie gespeichert.

Einmalig einrichten (kostenlos):

1. Auf https://supabase.com ein Konto und ein neues Projekt anlegen. Region: **Central EU (Frankfurt)**. Das Datenbank-Passwort brauchst du für die App nicht.
2. Links auf **SQL Editor** gehen, den Inhalt von `supabase/schema.sql` einfügen und auf **Run** klicken.
3. **Authentication → Sign In / Providers → Email** öffnen, **Confirm email** ausschalten und speichern. Dann ist kein Mail-Versand nötig.
4. **Project Settings → API Keys** öffnen und die **Project URL** und den **Publishable key** (oder den alten **anon public**-Schlüssel) in `config.js` eintragen. Niemals den secret- bzw. service_role-Schlüssel.
5. In der App unter **Einstellungen → Konto** E-Mail und Passwort eingeben und einmal auf „Neues Konto erstellen“ tippen. Auf allen anderen Geräten dann mit denselben Daten auf „Anmelden“.

„Passwort vergessen“ gibt es in der App noch nicht. Speicher das Passwort am besten im Passwort-Manager (auf dem iPhone im Schlüsselbund). Achtung: Ein Konto im Supabase-Dashboard zu löschen löscht auch alle seine Einträge.

`config.js` darf mit hochgeladen werden. Der anon-Schlüssel ist für die Öffentlichkeit gedacht, die Daten schützt die Datenbank selbst: Jede Person sieht nur ihre eigenen Einträge.

Gut zu wissen: Gratis-Projekte schlafen nach 7 Tagen ohne Nutzung ein. Dann im Supabase-Dashboard auf „Restore“ klicken.

## Aufs iPhone

1. Lad den Ordner kostenlos bei https://app.netlify.com/drop hoch (per Drag & Drop). **Lass `config.local.js` dabei weg**, denn alles, was hochgeladen wird, kann jeder lesen.
2. Öffne die Adresse, die du von Netlify bekommst, in Safari auf dem iPhone.
3. Tipp auf Teilen und dann auf „Zum Home-Bildschirm“. Jetzt startet die App mit Mond-Symbol und im Vollbild.
4. Trag in der App unter **Einstellungen** deinen Gemini-Schlüssel ein und melde dich mit deinem Konto an.

Ohne Konto werden Liste und gute Momente auf jedem Gerät getrennt gespeichert. Auf dem iPhone haben Safari und die App auf dem Home-Bildschirm sogar getrennte Speicher.

## Audio

Den Text der Meditation findest du in `meditation/meditation-text.md`. Erzeug daraus in ElevenLabs eine Audiodatei und speichere sie als `audio/meditation.mp3`. Die Hintergrundmusik kommt nach `audio/musik.mp3`.
Fehlt eine der Dateien, funktioniert die App trotzdem (siehe `audio/HIER-DATEIEN-ABLEGEN.txt`).
