# SSL vMix – dashboard danych i grafik

Lokalna aplikacja dla operatora transmisji regat: drużyny i ich 11 slotów graficznych (PNG), baza zawodników, floty po cztery łódki oraz dzienne deklaracje załóg z synchronizacją ze strony organizatora. Dane trzymane są w SQLite i w lokalnym katalogu plików. Przygotowuje grunt pod późniejsze zasilanie grafik vMix (JSON / Google Sheets).

Interfejs jest po angielsku. Zakładki: **vMix graphics** (domyślna, działająca) i **Commentator** (ekran „w przygotowaniu”).

Ekran startowy **Overview** to jedna tabela wszystkich drużyn: flaga, kod, nazwa, flota w wybranym zestawie, stan 11 grafik, liczba żeglarzy i deklaracja na wybrany dzień. Kliknięcie drużyny rozwija jej żeglarzy (zdjęcie, numer i pozycja z profilu, numer i pozycja z deklaracji dnia, najlepsze wyniki). Wyszukiwarka filtruje po drużynie i nazwisku, a dane odświeżają się co 30 s.

## Wymagania

- Node.js **22.12 lub nowszy** (albo 20.19+), npm. Starsze wersje (np. 22.11) nie instalują natywnego modułu narzędzia budującego (Vite/rolldown) i `npm run build` kończy się błędem „Cannot find native binding”. Sprawdź: `node -v`.
- Windows, macOS lub Linux. `better-sqlite3` ma gotowe binaria dla popularnych platform, więc zwykle nie trzeba kompilatora.

## Uruchamianie jednym kliknięciem (z automatyczną aktualizacją)

- **macOS:** kliknij dwukrotnie `start.command` w folderze projektu (za pierwszym razem: prawy przycisk → Otwórz).
- **Windows:** kliknij dwukrotnie `start.bat`.

Skrypt pobiera najnowszą wersję z GitHuba, a gdy coś się zmieniło, sam robi `npm install` i `npm run build`. Potem uruchamia dashboard i otwiera go w przeglądarce. Bez internetu startuje bieżącą wersję. Zamknięcie okna terminala zatrzymuje dashboard.

## Uruchomienie

```bash
npm install
npm run build
npm start
```

Dashboard: <http://127.0.0.1:4310>. Domyślnie serwer słucha tylko na tym komputerze.

Tryb deweloperski (przeładowanie na żywo, UI na porcie 5173, API na 4310):

```bash
npm run dev
```

Dane demonstracyjne (opcjonalnie, oznaczone „DEMO”): **Settings → Demo data → Load demo data** albo `npm run seed:demo` (`npm run seed:demo -- --remove` usuwa). Przycisk „Import test declaration page (DEMO)” przepuszcza przez importer plik `server/fixtures/demo-crew-list.html` o strukturze strony SSL, ale z fikcyjnymi drużynami DMA–DMH i nazwiskami „Demo …”.

Testy: `npm test`. Kontrola typów: `npm run typecheck`.

## Gdzie są dane

| Co | Domyślnie | Zmienna środowiskowa |
|---|---|---|
| Katalog danych | `data/` w katalogu projektu | `DATA_DIR` |
| Baza SQLite | `data/ssl-vmix.sqlite` (+ pliki `-wal`, `-shm`) | `DB_PATH` |
| Przesłane pliki | `data/assets/teams/<id drużyny>/<slot>_<losowy>.png`, `data/assets/sailors/<id>/photo_<losowy>.png/jpg` | `ASSETS_DIR` |
| Port / adres | `4310` / `127.0.0.1` | `PORT` / `HOST` |

Przesłane pliki dostają unikalne nazwy w katalogu właściciela, więc dwa pliki `flag.png` różnych drużyn nigdy się nie nadpiszą. Przy zastąpieniu grafiki stary plik tego slotu jest usuwany. Migracje bazy uruchamiają się automatycznie przy starcie.

## Kopia zapasowa i odtwarzanie

```bash
npm run backup                 # → backups/<data-czas>/ (baza + katalog assets)
npm run backup -- D:\Kopie\SSL # → D:\Kopie\SSL\<data-czas>\
```

Kopię można robić przy działającym serwerze (używane jest bezpieczne API kopii SQLite). Odtwarzanie, przy **zatrzymanym** serwerze:

```bash
npm run restore -- backups/2026-06-11-08-30-00
```

Bieżąca baza i katalog plików są przed odtworzeniem zachowywane z sufiksem `.before-restore-<data>`. Ręcznie wystarczy też skopiować plik `ssl-vmix.sqlite` i katalog `assets` przy zatrzymanym serwerze.

## Dashboard i vMix na różnych komputerach (sieć lokalna)

1. Uruchom serwer z dostępem z sieci:
   - PowerShell: `$env:HOST="0.0.0.0"; npm start`
   - cmd: `set HOST=0.0.0.0 && npm start`
   - macOS/Linux: `HOST=0.0.0.0 npm start`
2. Zezwól na port 4310 w zaporze (Windows: Zapora Defender → reguła przychodząca TCP 4310, profil „Prywatna”).
3. Otwórz `http://<IP-komputera-z-dashboardem>:4310` z innego komputera.
4. Aby vMix widział przesłane grafiki, udostępnij katalog `data/assets` w sieci (np. udział SMB `\\DASHBOARD-PC\ssl-assets`, tylko do odczytu wystarczy) i wpisz tę ścieżkę w **Settings → Files & vMix paths**. Dashboard pokaże wtedy dla każdego pliku ścieżkę do użycia w vMix.

Aplikacja nie ma logowania. Nie wystawiaj jej do internetu; używaj tylko w zaufanej sieci lokalnej.

### Trzy rodzaje ścieżek

- **Plik zapisany przez aplikację**: plik w `data/assets`, pokazany jako „Zapis”.
- **Adres podglądu**: `/api/assets/<id>/file`, serwowany przez backend. Przeglądarka nigdy nie czyta lokalnych ścieżek bezpośrednio.
- **Ścieżka dla vMix**: dla przesłanych plików budowana z ustawionego katalogu vMix; dla ręcznie wpisanych ścieżek (np. `D:\SSL\flag.png`, `\\VMIX-PC\grafiki\flag.png`) używana dosłownie.

Statusy: „Plik zapisany”, „Ścieżka dostępna” (serwer dashboardu odczytał plik i zrobił podgląd) oraz „Ścieżka niezweryfikowana” (zapisana, ale serwer nie ma do niej dostępu, więc „Podgląd niedostępny”). Dostępność pliku na komputerze vMix **nie jest** sprawdzana i nie jest tak oznaczana. Wpisana ścieżka zaczynająca się od skonfigurowanego katalogu vMix jest mapowana z powrotem na lokalny `data/assets`, więc podgląd działa.

## Deklaracje załóg i synchronizacja

### Co ustaliłem o źródle

Strona archiwalna `https://onb.sslgoldcup.com/qualify3/index.php/en/daily-weight-declaration` (stan z czerwca 2026) to lista Joomla/Fabrik:

- dane są w **tabeli HTML**; strona nie ładuje ich osobnym API i nie linkuje PDF-ów;
- kolumny: `Country | Sailing Date | Crews | Total Weight | Posted | (View)`;
- `Country` to kod organizatora (AUT, BEl, EST…), `Sailing Date` to `DD-MM` **bez roku**, `Posted` to `DD-MM HH:MM`;
- załoga jest w jednej komórce: `Imię Nazwisko (W:67.00) (J-23) -->Pozycja`, kolejne osoby bez separatora lub w nowych liniach;
- są wiersze grup dat (`11-06(7)`) i „No records”, a każdy wiersz ma link „View” do `.../details/67/<id>`.

Zastrzeżenie: z tego środowiska nie dało się pobrać surowego HTML (proxy odrzuciło połączenie z tym hostem), więc strukturę ustaliłem z wyrenderowanej treści strony listy i strony szczegółów. Dlatego importer szuka tabeli **po tekstach nagłówków**, a nie po klasach CSS czy pozycjach kolumn, i rozpoznaje osoby po wzorcu `(J-…) -->`. Weryfikacja na żywej stronie to pierwsza rzecz do sprawdzenia przyciskiem **Fetch now**. Jeśli serwer nie ma dostępu do strony, można ją zapisać w przeglądarce (Ctrl+S) i wczytać przyciskiem **Import saved HTML file**.

Importer: `server/src/importers/sslFabrikCrewList.ts`, rejestr: `server/src/importers/index.ts`. Kolejne zawody dostają nowy moduł z tym samym interfejsem `Importer.parse(body, { year, baseUrl })`.

### Jak działa synchronizacja

- Harmonogram działa w backendzie (sprawdzenie co 15 s, czy minął interwał; domyślnie 30 min), także po zamknięciu karty. Gdy serwer lub komputer jest wyłączony, nic nie jest pobierane.
- Jedno zadanie naraz: blokada w pamięci i rekord `running` w bazie (obejmuje też drugi proces na tej samej bazie).
- Ustawienia: URL, importer, wł./wył., interwał, strefa czasowa i rok wydarzenia (w sekcji Wydarzenie), „Pobierz teraz”, czas ostatniej próby, ostatniego sukcesu, następnej próby, status i opis błędu, historia z podsumowaniami.
- Pobranie (`fetch`, limit 20 s) → pełne parsowanie → zapis w jednej transakcji. Błąd sieci, HTTP lub parsowania nie zmienia żadnych danych.
- Node `fetch` nie korzysta z systemowego proxy HTTP. W sieci, która wymaga proxy, użyj importu zapisanego pliku.

### Zasady importu

- Data deklaracji to `Sailing Date` z rokiem wydarzenia, nigdy data pobrania.
- Import zapisuje tylko wartości źródłowe (`src_*`). Ręczne korekty (`ovr_*`) mają pierwszeństwo, nie są nadpisywane i można je cofnąć przyciskiem ↺. Rozbieżności trafiają do podsumowania jako konflikty.
- Import nie modyfikuje profili zawodników (zdjęcia, osiągnięcia, wartości domyślne) ani deklaracji z innych dni.
- Ponowny import tych samych danych nie tworzy duplikatów (klucz: wydarzenie + drużyna + dzień, w składzie znormalizowane nazwisko).
- Drużyny dopasowywane po kodzie, nazwie i aliasach; nieznane są zgłaszane, nie tworzone.
- Zawodnicy: identyfikator źródłowy (gdy istnieje), potem zapamiętane ręczne przypisania, potem znormalizowane imię i nazwisko w obrębie drużyny (wielkość liter, akcenty, odwrócona kolejność). Numer i pozycja nie służą do identyfikacji. Kilka pasujących osób oznacza „Niejednoznaczny”, bez łączenia. Nierozpoznane rekordy można przypisać lub utworzyć z nich profil.
- Osoba, która zniknęła ze źródła, jest usuwana ze składu, chyba że operator ją edytował; wtedy zostaje z oznaczeniem „Brak w źródle”.
- Wagi i inne zbędne dane nie są zapisywane.

## JSON dla vMix

Przycisk **JSON** na ekranie Teams & crews pokazuje adresy do wklejenia w vMix (Data Sources → JSON). Każdy wiersz to płaski obiekt z samymi tekstami, a pola grafik zawierają ścieżkę, której ma użyć vMix (mapowanie z Settings, a bez niego lokalną ścieżkę pliku).

- `/json/teams`: drużyny z 11 grafikami.
- `/json/sailors`: żeglarze z deklaracji na dziś (bez deklaracji cały skład). Parametry: `?date=RRRR-MM-DD`, `?team=KOD`.
- `/json/fleets/<id>`: floty zestawu, 4 miejsca na flotę; nierozstrzygnięte miejsca mają etykietę zamiast kodu.

Jeśli vMix działa na innym komputerze, uruchom dashboard z `HOST=0.0.0.0` (patrz sekcja o sieci lokalnej).

## Matchboard SSL Gold Cup 2026

**Settings → Matchboard → Load SSL Gold Cup 2026 matchboard** (albo `npm run seed:goldcup`) tworzy 61 drużyn z kodami z matchboardu i po jednym zestawie flot na etap: Qualifying Series, 1/32, 1/16, 1/8, ćwierćfinały, półfinały i finał. Miejsca jeszcze nierozstrzygnięte (losowanie, wyniki wcześniejszych rund) zostają puste z etykietą, np. „R1 C1” albo „DRAW 3”. Ponowne uruchomienie niczego nie dubluje: drużyny z istniejącym kodem i zestawy o istniejącej nazwie są pomijane.

## Floty

Zestaw flot (runda) należy do wydarzenia; drużyna może być w jednym miejscu danego zestawu, a różne zestawy dzielą te same drużyny inaczej. Flota ma cztery uporządkowane miejsca (ograniczenie także w bazie). Niepełna flota jest oznaczona jako niekompletna. Upuszczenie na zajęte miejsce otwiera wybór: jawna zamiana albo wolne miejsce. Alternatywy dla przeciągania: listy wyboru w pustych miejscach, ↑ ↓, przeniesienie do innej floty, ✕. Przeciąganie działa też z klawiatury (Tab do drużyny, spacja, strzałki, spacja).

## Architektura

```
server/   Node + TypeScript, Fastify, better-sqlite3, zod, cheerio
  src/db/migrations.ts       schemat i migracje
  src/services/              logika: zasoby, ścieżki, drużyny, zawodnicy, floty, deklaracje, import, sync, demo
  src/importers/             moduły importu źródeł
  src/app.ts                 API REST (/api/...) + serwowanie zbudowanego UI
  test/                      vitest
  fixtures/demo-crew-list.html  testowa strona DEMO
web/      React + TypeScript + Tailwind (Vite), TanStack Query, dnd-kit
```

Model danych: `events`, `teams` (kod, aliasy), `assets` (właściciel + slot, plik przesłany lub ścieżka, wymiary, status), `sailors` (profil + domyślna pozycja i numer), `sailor_source_aliases`, `fleet_sets` → `fleets` → `fleet_slots`, `declarations` (wydarzenie + drużyna + dzień) → `declaration_members` (wartości źródłowe i ręczne osobno), `sync_runs`, `settings`. Identyfikatory to UUID.

Pod przyszły eksport (profile JSON / Google Sheets dla grafik) model już daje: wybór drużyny, floty, zawodnika i dnia, skuteczne wartości pól (`COALESCE(ovr, src)`) oraz ścieżki dla vMix w każdym zasobie. Samego kreatora eksportu jeszcze nie ma.

## Ograniczenia tej wersji

- Importer nie był uruchomiony na surowym HTML żywej strony (patrz wyżej); jest przetestowany na odtworzonej strukturze i na fragmentach tekstu z tej strony.
- Brak logowania i uprawnień; jedno aktywne wydarzenie.
- Zmiana katalogu zasobów odbywa się zmienną środowiskową, nie z interfejsu.
- Bez modułu Commentator, edycji `.gtzip`, sterowania vMix, kreatora eksportu i integracji z Google.
