# ROSE Market

Polska przeglądarka publicznych danych o sklepach graczy **ROSE Online Global**. Pomaga znaleźć oferty i ostatnio zaobserwowane położenie sprzedawcy w **Junon Polis**.

- **Strona:** https://abeel87.github.io/rose-market/
- **Repozytorium:** https://github.com/Abeel87/rose-market

## Stan danych — 27 października 2026

**Rynek jest archiwum. ROSE Online Toolbox zakończył aktualizowanie cen 24.10.2026.** Dostawca potwierdza to na [stronie rynku](https://roseonlinetoolbox.com/market). Ostatnie oferty i historia są zachowane, ale nie potwierdzają dzisiejszej dostępności sklepów. Poprzednie udane pobrania zwracały tę samą kopię.

Publikacja oznacza zakończone źródło jako `source_retired`, bez ponownego pobierania zamrożonej kopii i bez zmiany dat obserwacji lub ostatniego udanego pobrania. Strona pokazuje wyraźny komunikat archiwum, a kontrola aktualnych danych nie zgłasza sukcesu.

Przygotowano diagnostykę bezpośredniego API ROSE Utils pod własny sekret `ROSEUTILS_API_TOKEN`. **Diagnostyka nie jest jeszcze importerem.** Brakuje uprawnionego dostępu, weryfikacji odpowiedzi na żywo oraz adaptera pełnych ofert i lokalizacji. [Kroki uzyskania i sprawdzenia dostępu](docs/roseutils-access.md).

## Co pokazuje aplikacja

- Oferty sprzedaży i skupu, nazwę przedmiotu oraz cenę oferty w Zulie.
- Nazwę gracza prowadzącego sklep, jego współrzędne i miejsce na mapie Junon Polis.
- Datę ostatniej obserwacji sklepu i datę kopii danych dostawcy.
- Wyszukiwanie i filtrowanie ofert oraz ulubione zapisywane w tej przeglądarce.
- Status źródła, datę kontroli oraz informację o zakończeniu aktualizacji.
- Historię minimalnych i maksymalnych cen sprzedaży oraz skupu, rozdzieloną według dni UTC.

To zapis obserwacji. **Pozycja na mapie nie potwierdza, że sklep nadal działa w tym miejscu ani że przedmiot jest jeszcze dostępny.** Mapa sklepów obejmuje tylko Junon Polis. Historia cen jest odrębnym zbiorem notowań dla serwera ROSE Online; jej rekordy nie potwierdzają miejsca oferty. Aplikacja nie łączy się z kontem w grze i nie prowadzi transakcji.

### Znaczenie ceny

Kwota jest opisana jako **cena oferty**. Źródło nie podaje ilości przedmiotów i nie pozwala potwierdzić, czy cena dotyczy jednej sztuki, czy całego stosu. Aplikacja nie przelicza jej automatycznie na cenę jednostkową ani nie dopisuje liczby sztuk.

## Dane i atrybucja

Źródłem pliku jest publiczny [marketStalls.json w ROSE Online Toolbox](https://roseonlinetoolbox.com/data/marketStalls.json). Metadane tego pliku wskazują [ROSE Utils Market](https://roseutils.com/market) jako źródło rynku. Ikony przedmiotów są dostarczane przez ROSE Online Toolbox. Nazwy i grafiki gry oraz dane zewnętrznych serwisów należą do ich właścicieli; to niezależny projekt fanowski.

Kopia początkowa z **24 października 2026 r.** zawierała 284 rekordy sklepów, 1196 wpisów w słowniku przedmiotów i 2222 oferty. Są to liczby opisujące tę konkretną kopię, a nie stałe ani gwarantowane aktualne liczby sklepów online.

Zachowujemy daty `_meta.fetchedAt`, `_meta.date` i `seenAt` dokładnie tak, jak przekazuje je dostawca. Udane pobranie pliku nie oznacza nowej obserwacji graczy. Własny czas próby pobrania znajduje się osobno w `dist/data/sync-status.json`.

## Publikacja archiwum

GitHub Actions publikuje katalog `dist/` przez GitHub Pages:

- po zmianach kodu, danych lub konfiguracji na gałęzi `main`;
- po ręcznym uruchomieniu workflow **Publish ROSE Market**;
- według harmonogramu o **08:37 i 20:37 UTC** każdego dnia, czyli zimą o 09:37 i 21:37, a latem o 10:37 i 22:37 w Polsce.

To godziny kontroli i publikacji, a nie obietnica nowych ofert. GitHub Actions może opóźniać zadania. Przycisk „Wczytaj ponownie” pobiera opublikowane archiwum Pages; nie uruchamia skanowania gry ani workflow.

Historyczna funkcja importu w `scripts/sync-market.mjs` pozostaje do testowania walidacji: jedno pobranie HTTPS, limit 25 sekund i 8 MiB, walidacja przez `normalizeSnapshot`, odrzucanie pustych i starszych kopii oraz atomowy zapis. **Workflow nie uruchamia już pobierania z zamrożonego źródła.** `npm run sync` zapisuje status zakończenia źródła i kończy się niezerowym kodem, nie zmieniając danych. Bezpośrednie uruchomienie starego skryptu CLI zgłasza zakończenie aktualizacji i wskazuje właściwe polecenie, bez pobierania ani zapisu.

Przed publikacją `scripts/published-data.mjs` odtwarza **ostatnią poprawną kopię z opublikowanej strony**, razem ze statusami rynku i historii. Sprawdza wszystkie cztery pliki oraz zgodność dat statusu z danymi. Kopia z czystego checkoutu nie zastępuje nowszego opublikowanego stanu. Jeśli nie można odczytać lub zweryfikować publikacji, workflow zatrzymuje się przed wdrożeniem i zostawia działającą stronę. Nowszy ręczny import historii w repozytorium wymaga uzgodnienia z publikacją, aby nie zgubić żadnej historii.

Po odtworzeniu archiwum `scripts/record-retired-source.mjs` sprawdza zgodność danych ze statusami i atomowo zapisuje status `source_retired` dla rynku oraz historii. Zachowuje ostatnie ceny, daty obserwacji i ostatnie udane pobranie. Workflow publikuje zweryfikowane archiwum wraz z tym statusem, a potem kończy się błędem kontroli aktualności. Powodem jest wycofane źródło, nie awaria publikacji strony. Brak nowego, spójnego statusu zatrzymuje wdrożenie.

`success` oznacza udane pobranie i walidację; `dataChanged` rozróżnia zmienione dane (`true`), identyczne obserwacje (`false`) i nieudaną lub zablokowaną próbę (`null`). `reason: source_retired` wyjaśnia trwałe zakończenie aktualizacji. `latestObservationAt` rynku oraz `latestObservationDate` historii wskazują czas rzeczywistych obserwacji, niezależny od czasu kontroli. Automatyczne uruchomienia nie dopisują commitów do repozytorium. Harmonogram nie przywraca aktualizacji po stronie dostawcy.

## Historia cen

Historię w `dist/data/price-history.json` utworzono skryptem `scripts/sync-history.mjs` z publicznego [API cen ROSE Online Toolbox](https://api.roseonlinetoolbox.com/api/v1/prices), które zakończyło aktualizacje. Poniższy opis dotyczy zachowanego importu i jego testów; obecne workflow go nie ponawia. Import obejmował wyłącznie serwer `rose-online`, z zapytaniem o ostatnie 90 dni. Dopasowanie przedmiotów wymaga tej samej nazwy po normalizacji Unicode NFC, usunięciu skrajnych spacji i zamianie liter na małe; warianty przedmiotu nie są łączone przez częściowe podobieństwo nazw.

Pierwszy pełny import wykonany **24 października 2026 r. o 09:58 UTC** obejmował 4728 rekordów cen na 48 stronach API i 1449 przedmiotów. Dostawca zwrócił wtedy obserwacje z **20 i 24 października 2026 r.** Zapytanie o 90 dni nie oznacza, że źródło ma notowania z każdego z tych dni.

Każdy punkt oznacza **dzień obserwacji w UTC**, wyznaczony z `submitted_at`. Dla tego dnia osobno obliczamy minimum i maksimum rekordów sprzedaży (`sellMin`, `sellMax`) oraz skupu (`buyMin`, `buyMax`). Brak strony rynku daje wartości `null`; brak notowań w danym dniu nie oznacza ceny zero. Nie korzystamy z API dziennych średnich, które łączy oferty kupna i sprzedaży.

Są to **notowania ofert, a nie potwierdzone transakcje**. Pola `sellCount` i `buyCount` liczą rekordy cen dostawcy; nie oznaczają liczby sprzedawców, transakcji ani wolumenu. Pole ilości z API nie jest używane do obliczania wolumenu ani ceny jednostkowej, ponieważ nie potwierdza porównywalnej jednostki ceny i może występować w powtórzonych raportach granicznych cen.

Pobranie obejmuje wszystkie strony odpowiedzi: po 100 rekordów, maksymalnie 100 stron i 10 000 rekordów. Działają najwyżej dwa równoległe zapytania. Skrypt sprawdza spójność paginacji, unikalność identyfikatorów rekordów, serwer, typ oferty, nazwę i identyfikator przedmiotu, całkowitą nieujemną cenę oraz datę obserwacji. Każde zapytanie ma limit 25 sekund, całość pięć minut. Przy HTTP 429 respektuje krótki `Retry-After`, z ograniczoną liczbą ponowień; dłuższe ograniczenie kończy próbę i zachowuje poprzednią kopię.

Historyczny importer zastępuje nakładające się koszyki dnia i typu oferty, aby ponowne pobranie nie podwajało liczników. Zachowuje starsze dostępne punkty w oknie 90 dni. Kopia zawiera tylko rzeczywiście dostarczone notowania — aplikacja nie dopisuje sztucznych dni ani nie prowadzi niezależnego zapisu wszystkich codziennych sklepów. GitHub Actions publikuje zachowane archiwum bez automatycznych commitów. Zakresy wykresu kończą się 24.10.2026, co jest opisane na stronie, dzięki czemu historia nie znika z widoku wraz z upływem czasu. Przywrócenie importu wymaga osobnej, zweryfikowanej integracji z nowym źródłem.

Status pobrania historii jest oddzielony od statusu mapy sklepów i zapisany w `dist/data/history-status.json`. Błąd sieci, niepełna odpowiedź lub zmiana schematu nie nadpisują dobrej historii i nie oznaczają jej jako odświeżonej.

## Uruchomienie lokalnie

Aplikacja jest statyczna i nie wymaga instalowania pakietów ani budowania. Z katalogu projektu uruchom serwer HTTP, na przykład:

```sh
python3 -m http.server 8000 --directory dist
```

Otwórz http://localhost:8000/. Serwer HTTP jest potrzebny do wczytania modułów JavaScript i pliku JSON.

Sprawdzenie kodu i testów wymaga Node.js:

```sh
npm test
npm run check
```

Testy synchronizacji używają wyłącznie izolowanych katalogów tymczasowych i odpowiedzi testowych. Obejmują pełną paginację, powtórny import, rozdzielenie kupna i sprzedaży, niepełne/niepoprawne dane, HTTP 429/503, stare kopie, daty z przyszłości oraz kolejne publikacje po awarii. Testy PR nie kontaktują się ze źródłami i nie publikują strony.

Kontrola statusu zakończonego źródła (zwraca błąd `source_retired`, zachowując dane):

```sh
npm run sync
```

Kontrola statusu źródła historii:

```sh
npm run sync:history
```

Sprawdzenie własnego dostępu do ROSE Utils:

```sh
npm run check:roseutils
```

Token jest odczytywany tylko z `ROSEUTILS_API_TOKEN`. Bez klucza nie jest wysyłane żadne zapytanie. Sprawdzenie nie publikuje danych i nie zmienia archiwum. Nieudane pobranie, brak dostępu lub nierozpoznany schemat kończą się kodem różnym od zera. Workflow **Check ROSE Utils access** wykonuje to sprawdzenie ręcznie z sekretu Actions.

## Prywatność i ograniczenia

Ulubione są przechowywane lokalnie w przeglądarce. Nie synchronizują się automatycznie pomiędzy urządzeniami. Informacje o sklepach pochodzą z publicznej bazy; aplikacja nie określa czasu pojawienia się gracza online ani nie śledzi go w czasie rzeczywistym.

Projekt nie jest oficjalnym produktem Rednim Games ani Gravity. Repozytorium nie nadaje dodatkowych praw do grafik gry ani danych zewnętrznych źródeł.
