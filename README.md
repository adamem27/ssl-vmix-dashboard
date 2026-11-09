# SSL vMix – dashboard danych i grafik

Lokalna aplikacja dla operatora transmisji regat: drużyny i ich 11 slotów graficznych (PNG), baza zawodników, floty po cztery łódki oraz dzienne deklaracje załóg z synchronizacją ze strony organizatora. Dane trzymane są w SQLite i w lokalnym katalogu plików. Przygotowuje grunt pod późniejsze zasilanie grafik vMix (JSON / Google Sheets).

Interfejs jest po angielsku. Zakładki: **vMix graphics** (dane i grafiki) i **Commentator** (podgląd dla komentatorów: zakładki flot, 4 składy obok siebie, po najechaniu na zawodnika popup ze zdjęciem, numerem, pozycją, kapitanem i wynikami; klawisze 1–9 przełączają floty).

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

## Wersje aplikacji

Numer wersji to `1.0.N`: N to liczba zmian w `main`, więc rośnie o jeden z każdym pushem i wyższy numer zawsze oznacza nowszą aplikację. Numer liczy `scripts/version.mjs` przy `npm run build` (zapisuje `server/dist/version.json` razem z listą zmian z opisów commitów). Wersja jest w prawym górnym rogu dashboardu; kliknięcie pokazuje listę zmian, a kropka oznacza, że od ostatniego otwarcia doszło coś nowego. Paczka Windows ma ten sam numer w opisie wydania, a `/api/health` i `/api/version` zwracają go przez API. Przy większej zmianie podbij ręcznie `MAJOR.MINOR` w głównym `package.json` (np. na `1.1`).

## Gdzie są dane

| Co | Domyślnie | Zmienna środowiskowa |
|---|---|---|
| Katalog danych | `data/` w katalogu projektu | `DATA_DIR` |
| Baza SQLite | `data/ssl-vmix.sqlite` (+ pliki `-wal`, `-shm`) | `DB_PATH` |
| Przesłane pliki | `data/assets/Teams/<KOD> - <nazwa>/<KOD> - <slot>.png`, `data/assets/Sailors/<KOD> - <nazwa>/<NAZWISKO> <Imię> - Photo.jpg`, `data/assets/People/<osoba> - Photo.jpg` (ponowne wgranie daje nazwę z „v2”, żeby vMix odświeżył obraz; zmiana nazwy drużyny przenosi pliki) | `ASSETS_DIR` |
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

## Komputer z vMixem (Windows) bez instalowania czegokolwiek

Paczka `ssl-dashboard-windows.zip` (GitHub → Releases → "Windows package (latest)") ma w środku przenośny Node i gotową aplikację. GitHub Actions buduje ją i testuje na Windows po każdej zmianie na `main`.

1. Rozpakuj do np. `C:\SSL-Dashboard` i uruchom `SSL Dashboard.bat`.
2. Przy pierwszym starcie pyta o klucz aktualizacji (GitHub fine-grained token: tylko to repo, Contents: Read-only) i gdzie jest baza:
   - adres panelu online (np. `https://sslgfx.em27code.com`) + hasło: dane edytujesz z dowolnego komputera, a ten PC tylko zapisuje lokalnie obrazy, `ssl-vmix.xlsx` i `ssl-vmix.json`,
   - Enter: panel i baza działają na tym PC (inne komputery w tej samej sieci: `http://<IP tego PC>:4310`).
3. Przy każdym starcie sprawdza i pobiera nową wersję; dane w `data\` zostają. Plik dla vMix: `C:\SSL-Dashboard\data\assets\ssl-vmix.xlsx`.
4. `Autostart ON.bat` / `Autostart OFF.bat` – start razem z Windows. Ustawienia (klucz, adres, hasło) są w `config.json`; usuń go, żeby odpowiedzieć na pytania od nowa.

## Dashboard online, pliki na komputerze z vMixem

Dashboard może działać na serwerze w internecie (obsługa z dowolnego komputera), a obrazy, `ssl-vmix.xlsx` i `ssl-vmix.json` i tak lądują lokalnie na komputerze z vMixem. vMix czyta tylko lokalne pliki, więc chwilowy brak internetu nie psuje grafik: zostają ostatnie dane.

**1. Serwer.** W repo jest `Dockerfile`. Działa na każdym hostingu z Dockerem i trwałym dyskiem (np. Railway, Render, Fly.io albo własny VPS):
- dysk (volume) podpięty pod `/data` – tam jest baza, obrazy i xlsx,
- zmienna `DASHBOARD_PASSWORD` – hasło do dashboardu (przeglądarka zapyta o nie raz; nazwa użytkownika dowolna),
- port `4310` (albo `PORT` ustawiony przez hosting).

Na własnym VPS: `docker build -t ssl-vmix . && docker run -d -p 4310:4310 -v ssl-data:/data -e DASHBOARD_PASSWORD=... ssl-vmix`, a przed tym HTTPS (np. Caddy).

**Hosting współdzielony z DirectAdmin (np. seohost.pl), bez Dockera.** npm w tym panelu (CloudLinux) nie obsługuje workspaces, dlatego serwer używa gałęzi `deploy` z gotową, zbudowaną aplikacją (GitHub Actions odświeża ją po każdej zmianie na `main`; ręcznie: `npm run build && node scripts/build-deploy.mjs <folder>`). W panelu: Node.js App → Node 22, katalog aplikacji = folder z kodem (nie `public_html`), plik startowy `app.cjs`, zmienne `DASHBOARD_PASSWORD` i `DATA_DIR` (folder poza `public_html`). W SSH, po komendzie `source ...` z panelu: `git clone -b deploy https://github.com/adamem27/ssl-vmix-dashboard.git <folder>` (lub `git pull` przy aktualizacji), `npm install`, potem "Uruchom ponownie" w panelu.

**2. Komputer z vMixem (Windows).** Potrzebny Node.js i to repo. Raz uruchom `install-vmix-sync.bat`: pyta o adres dashboardu, hasło i lokalny folder (domyślnie `C:\SSL-vMix`), startuje synchronizację i dodaje ją do autostartu Windows (zminimalizowane okno "SSL vMix sync", samo się restartuje). `uninstall-vmix-sync.bat` usuwa autostart. Co 2 sekundy:
- kopiuje nowe i zmienione obrazy oraz `ssl-vmix.xlsx`, usuwa skasowane,
- zapisuje `ssl-vmix.json` (to samo co `/json/all`),
- ustawia w dashboardzie folder vMix na ten lokalny folder, więc ścieżki obrazów w xlsx/JSON wskazują pliki na komputerze z vMixem.

W prawym górnym rogu dashboardu jest znacznik "vMix PC": zielony = synchronizacja działa, czerwony = komputer z vMixem nie łączy się albo jest błąd zapisu.

W vMix: Data Sources → Excel → `C:\SSL-vMix\ssl-vmix.xlsx` (lub JSON → `C:\SSL-vMix\ssl-vmix.json`). Okno synchronizacji musi być otwarte.

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

## Jeden plik dla vMix (Excel z arkuszami)

Dashboard sam utrzymuje plik `data/assets/ssl-vmix.xlsx` z siedmioma arkuszami: **General** (bloki z tytułami: Event i Matchboard obok Weather, potem każda grafika ogólna z wersjami w kolumnach i na końcu harmonogram dnia; kolumny nazywają się literami, więc pole w vMix to kolumna + wiersz jak komórka w Excelu), **Teams** (wiersz na drużynę: grupa, miejsce, nazwy, ranking, grafiki), **Sailors** (wiersz na żeglarza: kapitan, miejsce w line-upie, deklaracja dnia, zdjęcie), **Line-up** (wiersz na drużynę: flaga, emblemat, tło line-upu, sponsorzy, potem miejsca na łodzi w kolejności z zakładki, każde z numerem, imieniem, nazwiskiem, pozycją, kapitanem i zdjęciem) **Results** (wiersz na drużynę w grupie), **Announcements** (wiersz na komunikat) i **People** (wiersz na osobę). Teams, Sailors i Results obejmują drużyny i grupy etapu wybranego w nagłówku dashboardu (pole „Stage”); ten sam etap ogranicza listy drużyn we wszystkich zakładkach i w danych JSON. Flagi (Flag small i Flag big) zawsze mają zaokrąglone rogi jak w projekcie (ok. 18% wysokości): dashboard zaokrągla każdą wgraną flagę, a przy pierwszym starcie nowej wersji także te wgrane wcześniej. Puste pola Background type 1 i 2 oraz Lowerthird photo i anthem drużyny dostają ścieżki PNG z generatora (Panel left, Square, Bar waves, Bar long); własny plik wgrany w to pole ma pierwszeństwo. Plik nadpisuje się w ciągu kilku sekund po każdej zmianie danych. W vMix dodaj go jako Data Source → Excel/CSV i wybierz arkusz. Ponieważ plik leży w folderze `data/assets`, udostępnienie tego folderu w sieci (patrz niżej) wystarcza, żeby vMix na innym komputerze go widział. Inne miejsce ustawisz zmienną `WORKBOOK_FILE`.

**Results prosto do vMix (bez mapowania Data Source).** W zakładce Results każda grupa ma pole „vMix input” (nazwa albo numer inputu z tytułem Group_overall_results_*) i przycisk **Send to vMix**. Dashboard przez Web API vMixa (w vMix: Settings → Web Controller) wpisuje do tytułu SUBTITLE (tytuł grupy), LOCATION (podtytuł, jeśli wpisany), nagłówki H1… (R1…), a w wierszu n: POS n, FLAG n (flaga mała), TEAM n, R1 n… i POINTS n, w kolejności tabeli. Kolumny wyścigów wypełnia od prawej, więc przy mniejszej liczbie wyścigów stoją przy Points (przy większej niż kolumn w tytule pokazuje ostatnie). Ustawia tylko pola, które ten input ma, a wiersze ponad liczbę drużyn czyści. Adres vMixa ustawiasz w Settings → Files & vMix paths (domyślnie `http://127.0.0.1:8088`, czyli vMix na tym samym komputerze co dashboard).

Jeden adres z wyborem arkusza jest też jako XML: `/xml/all`. W vMix: Data Source → XML, adres `http://<komputer>:4310/xml/all`, XPath np. `//sheet[@name='Teams']/row` (ekran JSON podaje XPath dla wybranego arkusza). Zbiorczy `/json/all` (nazwy arkuszy jako klucze) jest dla innych narzędzi; źródło JSON w vMix czyta tablicę obiektów, więc w vMix używaj adresów pojedynczych arkuszy, np. `/json/teams`. Ekran **JSON** pokazuje arkusze jak w Excelu: zakładki na dole, numery wierszy i kolumn, ścieżkę pliku i przycisk pobrania.

## JSON dla vMix

Przycisk **JSON** na ekranie Teams & crews pokazuje adresy do wklejenia w vMix (Data Sources → JSON). Każdy wiersz to płaski obiekt z samymi tekstami, a pola grafik zawierają ścieżkę, której ma użyć vMix (mapowanie z Settings, a bez niego lokalną ścieżkę pliku).

- `/json/teams`: drużyny z 11 grafikami.
- `/json/sailors`: żeglarze z deklaracji na dziś (bez deklaracji cały skład). Parametry: `?date=RRRR-MM-DD`, `?team=KOD`.
- `/json/fleets/<id>`: floty zestawu, 4 miejsca na flotę; nierozstrzygnięte miejsca mają etykietę zamiast kodu.
- `/json/captains`: kapitan każdej drużyny (imię, nazwisko, numer, pozycja, wyniki, zdjęcie) z flagą drużyny. Kapitana zaznacza się gwiazdką w składzie; `/json/teams` i `/json/sailors` też zawierają pola kapitana.
- `/json/weather`: aktualna pogoda (jeden wiersz).
- `/json/schedule`: harmonogram na dziś, `?date=RRRR-MM-DD` na inny dzień.
- `/json/people`: osoby do lowerthirdów, filtry `?role=Host commentator`, `?language=Polish`.

Ekran **JSON** pokazuje każde źródło jak arkusz: numery wierszy i numery kolumn z nazwą pola. Kliknięcie komórki pokazuje jej wiersz, kolumnę, nazwę pola i wartość.

Ekran **General graphics** zawiera pogodę, harmonogram dnia i osoby. Przycisk „+ 3 commentators” dodaje host, guest i on-water commentator dla wpisanego języka.

Jeśli vMix działa na innym komputerze, uruchom dashboard z `HOST=0.0.0.0` (patrz sekcja o sieci lokalnej).

## Matchboard SSL Gold Cup 2026

**Settings → Matchboard → Load SSL Gold Cup 2026 matchboard** (albo `npm run seed:goldcup`) tworzy 61 drużyn z kodami z matchboardu i po jednym zestawie flot na etap: Qualifying Series, 1/32, 1/16, 1/8, ćwierćfinały, półfinały i finał. Miejsca jeszcze nierozstrzygnięte (losowanie, wyniki wcześniejszych rund) zostają puste z etykietą, np. „R1 C1” albo „DRAW 3”. Ponowne uruchomienie niczego nie dubluje: drużyny z istniejącym kodem i zestawy o istniejącej nazwie są pomijane.

## Generator PNG (gradienty krajów)

Ekran **PNG generator** zastępuje ręczne eksporty z Illustratora. Każda drużyna ma do trzech wersji gradientu (V1, V2, V3), a każdy **element PNG** (prostokąt) mówi, której wersji używa.

- **Gradient:** suwak z punktami (klik w pasek dodaje punkt, przeciąganie przesuwa, strzałki ←/→ przesuwają o 1%, z Shift o 10%). Każdy punkt ma kolor (próbnik, HEX, R G B), przezroczystość i pozycję. Do tego kąt i odwrócenie ⇄.
- **Szybko:** dwa lub trzy kolory → „→ V1 V2 V3” tworzy wszystkie trzy wersje naraz (V1 pełny, V2 z przezroczystym początkiem, V3 przezroczysty na obu końcach). „Copy V…” i „Copy from team…” kopiują gotowy gradient.
- **Element PNG:** nazwa, nazwa pliku, wersja gradientu, szerokość × wysokość, zaokrąglenie rogów (px), dodatkowa przezroczystość, lustrzane odbicie, korekta kąta, obwoluta (grubość, kolor, przezroczystość; rysowana do środka, więc wymiar się nie zmienia; opcjonalnie gradientowa z własnym kątem) i fale Copacabana (wł./wył., przezroczystość, skala).
- **Obwoluta gradientowa:** zaznacz „Gradient” przy obwolucie elementu i ustaw jej kąt („Stroke ∠”, domyślnie −45°). Wszystkie takie elementy używają jednego gradientu z panelu „Stroke gradient” (domyślnie jak w `gradienty.ai`: zielony #00B15E → niebieski #0085E6, wygaszony na końcach); „Reset to gradienty.ai” przywraca go. Panele i `bar_waves` mają ją od startu (1 px).
- **Fale Copacabana:** zawsze ten sam kształt, przeniesiony 1:1 z `gradienty.ai` (czarne pasy, długość fali 81,111 px, rząd co 60,833 px). Element ustala tylko, czy ma fale, ich krycie (w pliku 10%) i skalę (100%, na małych elementach 53,3%).
- **Podgląd:** wszystkie elementy wybranej drużyny albo jeden element dla wszystkich drużyn, na szachownicy, ciemnym lub jasnym tle. Podgląd liczy ten sam kod co eksport, więc piksele są te same.

Eksport: przy włączonym **Auto export** pliki zapisują się w ciągu kilku sekund po zmianie do `data/assets/PNG generator/<KOD>/<KOD>_<plik>.png` (renderowane są tylko zmienione pliki, a pliki usuniętych elementów i zmienionych kodów są kasowane). Ponieważ to katalog `assets`, `sync-vmix` kopiuje je na komputer z vMixem, np. `C:\SSL-vMix\PNG generator\POL\POL_bar.png`. Ścieżki trafiają do arkusza **Teams** w `ssl-vmix.xlsx` (kolumny „PNG <element>”). „Export now” renderuje wszystko od nowa, „ZIP” pobiera komplet.

Na start generator dodaje 7 elementów z wymiarami i zaokrągleniami artboardów z `gradienty.ai` (929×75, 851×390 ×2, 802×102, 1130×75, 289×40, 210×134) i gradienty 11 drużyn odczytane z tej tablicy (MAR, MOZ, SEY, TAH, AUT, EST, SLO, BEL, LTU, NOR, SRB). Pozostałe drużyny czekają na swoje kolory.

### Zestaw neutralny

Kolumna **For** w tabeli elementów decyduje, w jakich barwach powstaje element: Teams (tylko drużyny), Neutral (tylko neutralne) albo Both (jedno i drugie). Elementy z „neutr” w nazwie lub nazwie pliku zostały przy aktualizacji jednorazowo oznaczone jako neutralne, pozostałe jako drużynowe. Neutralne elementy mają wypełnienie jak w finals-broadcast_ssl26_v2.ai (#1a1a1a, krycie 80%) i żółto-pomarańczową obwolutę w pełnym kolorze; wersja działa jak u drużyn (V1 pełna, V2 narasta, V3 narasta i zanika). Pliki trafiają do `PNG generator/NEUTRAL/NEUTRAL_<element>.png` i są w `/json/graphics` jako wiersz `NEUTRAL`. Kolumna **Gradient from** ustawia, z której strony zaczyna się gradient: lewa, prawa, góra albo dół (obwoluta obraca się razem z nim).

## Lowerthirdy ze Stream Decka (Companion)

Zakładka **Lower thirds** to te same klawisze co na Stream Decku: kraj wybiera drużynę, pozycja na łódce pokazuje żeglarza z dzisiejszego składu (zdjęcie, flaga, emblem, imię i nazwisko, numer i pozycja), NEXT RESULT przełącza tylko dolną linię na kolejne best results, TEAM pokazuje drużynę, OUT zdejmuje grafikę.

- Gdy lowerthird jest na antenie, dashboard wysyła do vMixa tylko zmienione pola, więc tytuł nie schodzi z anteny, a grają animacje DataChange z GTZIP.
- Żeglarz ze zdjęciem idzie na `lowerthird_photo`, drużyna i żeglarz bez zdjęcia na `lowerthird_no_photo` (nazwy do zmiany w ustawieniach zakładki).
- W Companion: połączenie **Generic HTTP**, jeden klawisz z akcją GET na `http://<dashboard>/api/lt/key/$(this:page)/$(this:row)/$(this:column)`, skopiowany na wszystkie klawisze stron podanych w zakładce.
- Etykiety klawiszy (kody krajów, nazwiska na pozycjach, kolor wybranego kraju i tego, co na antenie) dashboard wysyła sam przez **HTTP remote control** Companiona, jeśli wpiszesz jego adres.
- Bezpośrednie adresy: `/api/lt/team?team=POL`, `/api/lt/sailor?team=POL&place=helm`, `/api/lt/next`, `/api/lt/out`.

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
