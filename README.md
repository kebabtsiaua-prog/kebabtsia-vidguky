# Кебабця · Відгуки

Telegram-апка для скарг гостей мережі «Кебабця»: збір скарг з усіх каналів, рішення, аналітика по точках і місяцях, співвідношення скарг до чеків.

## З чого складається

| Частина | Де живе | Як оновлюється |
|---|---|---|
| Апка (екрани) | `index.html`, GitHub Pages | сама, після кожної зміни в `main` |
| Сервер `api` (дані для апки) | `supabase/functions/api` | GitHub Actions → Supabase |
| Бот `@kebabtsia_vidguky_bot` (скриншоти → скарги) | `supabase/functions/bot` | GitHub Actions → Supabase |
| База даних | `supabase/migrations` | GitHub Actions → Supabase |
| Не дати Supabase «заснути» | `.github/workflows/keepalive.yml` | щодня сам |

Усе працює в хмарі. Комп'ютер для роботи апки не потрібен.

## Секрети

Секрети ніколи не пишуться в код і не надсилаються в чат. Їх вставляє власник у налаштуваннях.

**GitHub → Settings → Secrets and variables → Actions → New repository secret**
- `SUPABASE_ACCESS_TOKEN`: Supabase → аватар → Account preferences → Access Tokens → Generate new token.
- `SUPABASE_DB_PASSWORD`: пароль бази, який задали при створенні проєкту Supabase.

**Supabase → Edge Functions → Secrets**
- `TELEGRAM_BOT_TOKEN`: токен бота від @BotFather.
- `ANTHROPIC_API_KEY`: ключ Claude API, щоб бот сам читав скриншоти. Без нього бот теж працює, але точку і канал треба вибирати кнопками.

## Перший запуск

1. Перша людина, яка натисне `/start` у боті, стає адміністратором.
2. Адміністратор у апці (шестерня → «Люди і доступ») створює коди для інших.
3. Кількість чеків за місяць вносить адміністратор: шестерня → «Чеки за місяць».

## Ролі

- **Адміністратор**: усе, плюс люди, точки і чеки.
- **Комунікаційник**: усі точки, записує рішення.
- **Адмін точки**: лише своя точка, додає Glovo і Bolt.
- **Оператор**: додає скарги з каналів «Оператори» і «Сайт», бачить лише свої.

## Якщо все зламалось

Код повністю в цьому репозиторії. Новий проєкт Supabase піднімається так: вставити два секрети GitHub і два секрети Supabase, замінити адресу проєкту в `index.html` і `.github/workflows/*.yml`, запустити Actions → «Deploy server» → Run workflow.
