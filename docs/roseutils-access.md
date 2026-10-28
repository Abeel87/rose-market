# Przywrócenie aktualnych danych ROSE Market

## Potwierdzona przeszkoda — 27 października 2026

[ROSE Online Toolbox](https://roseonlinetoolbox.com/market) zakończył aktualizowanie cen i ofert 24 października 2026. Nasze wcześniejsze pobieranie działało, ale zwracało tę samą archiwalną kopię. Częstszy harmonogram nie może wytworzyć nowych obserwacji.

API ROSE Utils istnieje: publiczny [klient RoseLite](https://github.com/DrezByte/RoseLite/blob/main/src/main.js) używa adresów `/api/market/prices`, `/api/market/available-dates` oraz historii wybranych przedmiotów. Anonimowe sprawdzenie `https://roseutils.com/api/market/available-dates` zwróciło HTTP 401 z komunikatem o braku tokena. Nie potwierdzono aktualności danych za uwierzytelnieniem.

Autor ROSE Utils podaje Discord **jero_4370** w [swoim wątku na oficjalnym forum gry](https://forum.roseonlinegame.com/topic/7615-roseutils-your-online-rose-online-utilities/). Nie znaleziono publicznej instrukcji wydawania klucza dla nowego projektu. Klucz używany przez inną aplikację nie jest konfiguracją tego projektu.

## Dostęp potrzebny do dalszej integracji

Od właściciela ROSE Utils należy uzyskać własny dostęp dla ROSE Market i ustalić:

1. Token do odczytu cen oraz historii i zasady ich publikowania na naszej stronie.
2. Limity zapytań i zalecaną częstotliwość pobierania.
3. Dostępność pełnych ofert kupna i sprzedaży, nazw sklepów, lokalizacji i oryginalnego czasu obserwacji. Zestawienie cen przedmiotów nie zastępuje listy sklepów.
4. Znaczenie ceny i ilości, rozdzielenie wariantów/ulepszeń oraz identyfikatory przedmiotów.

## Gdzie zapisać własny token

W [ustawieniach sekretów GitHub Actions tego repozytorium](https://github.com/Abeel87/rose-market/settings/secrets/actions) utwórz sekret **ROSEUTILS_API_TOKEN**. Nie zapisuj jego wartości w plikach `dist/`, commitach, opisach PR ani logach. Do lokalnej diagnostyki klient odczytuje tę samą zmienną środowiskową.

Następnie uruchom ręcznie workflow **Check ROSE Utils access** z gałęzi `main`. Workflow ma wyłącznie uprawnienia odczytu repozytorium. Nie publikuje strony i nie nadpisuje żadnych danych. Klient korzysta tylko ze stałego originu `https://roseutils.com`, nie przekazuje uwierzytelnienia przez przekierowania i ogranicza czas oraz rozmiar odpowiedzi.

Lokalne polecenie diagnostyczne (po ustawieniu sekretu w środowisku):

```sh
npm run check:roseutils
```

Brak klucza zatrzymuje sprawdzenie przed połączeniem z dostawcą. Diagnostyka pokazuje wyłącznie bezpieczne informacje o odpowiedzi; nie drukuje tokena, treści odpowiedzi ani danych sklepów. Sprawdzenie połączenia nie oznacza wykonania importu.

## Co pozostaje po uzyskaniu dostępu

Należy sprawdzić rzeczywisty schemat i świeżość odpowiedzi, dopasować identyfikatory bez zgadywania, a następnie przygotować adapter oraz jego testy na zanonimizowanej próbce. Ceny zbiorcze i lista sprzedawców wymagają osobnej walidacji. Brakujących sklepów, lokalizacji, ilości lub dawnych dni historii nie wolno dopisywać.

Dopiero po próbnym pobraniu kompletnych, nowszych danych można zastąpić etapy `record-retired-source.mjs` w workflow publikacji. Do tego czasu dane, mapa i wykresy pozostają wyraźnie oznaczonym archiwum. Samo dodanie sekretu nie przełącza jeszcze źródła.

## Zachowanie obecnej publikacji

Każde wdrożenie odtwarza ostatnie zweryfikowane dane z Pages. `record-retired-source.mjs` zmienia tylko statusy na `source_retired`, zachowując ceny, daty obserwacji i datę ostatniego udanego pobrania. Nie odpytuje zamrożonych źródeł. Poprawna walidacja i zapis statusu kończą krok kodem 0; błąd walidacji lub zapisu zatrzymuje publikację.

Udane wdrożenie archiwum ma zielony status GitHub Actions. Niedostępność aktualnych danych jest widoczna jako ostrzeżenie i w podsumowaniu, a status źródła nadal ma `success: false` oraz `dataChanged: null`. Testy, zapis plików i samo wdrożenie nadal muszą się powieść. Zielony status publikacji nie oznacza przywrócenia bieżących cen.
