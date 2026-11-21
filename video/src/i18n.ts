// The film's text in Russian. Keys are the English strings as they appear in Presentation.tsx;
// a missing key falls back to English. The footage itself is not translated (the product UI is English).
import { createContext, useContext } from "react";

export type Lang = "en" | "ru";
export const LangContext = createContext<Lang>("en");

const RU: Record<string, string> = {
  // title and problem
  "A working slice": "Рабочий срез",
  "Gamification for casino operators": "Геймификация для казино",
  "deposit → wheel → coins → bonus, across two casino platforms": "депозит → колесо → монеты → бонус, на двух платформах казино",
  "The problem": "Задача",
  "Two casinos, two different APIs, and coins that act like money": "Два казино, два разных API, а монеты ведут себя как деньги",
  "Alpha (platform A) answers at once and accepts an idempotency key.": "Alpha (платформа A) отвечает сразу и принимает ключ идемпотентности.",
  "Beta (platform B) accepts, then reports the result later by webhook. No idempotency key.":
    "Beta (платформа B) принимает запрос, а результат присылает позже вебхуком. Ключа идемпотентности нет.",
  "The casino may answer late, twice, or never.": "Казино может ответить поздно, дважды или не ответить вовсе.",
  "Rules: no bonus issued twice. No negative balance.": "Правила: бонус не выдаётся дважды. Баланс не уходит в минус.",
  // architecture
  Architecture: "Архитектура",
  "One domain model, one adapter per platform": "Одна доменная модель, по адаптеру на платформу",
  "Casino Alpha": "Казино Alpha",
  "Casino Beta": "Казино Beta",
  "platform A, simulated": "платформа A, поддельная",
  "platform B, simulated": "платформа B, поддельная",
  "answers at once": "отвечает сразу",
  "result later by webhook": "результат позже, вебхуком",
  "Player and staff": "Игрок и персонал",
  "widget on the casino page": "виджет на странице казино",
  "back office: sign-in, roles": "бэк-офис: вход, роли",
  "Our service": "Наш сервис",
  "Adapter A · Adapter B": "Адаптер A · Адаптер B",
  "Events → spins → coins": "События → спины → монеты",
  "Store: redemption state machine": "Магазин: машина состояний заявки",
  "Outbox jobs with leases": "Задания outbox с арендой",
  "Workers scale by count": "Воркеры масштабируются числом",
  "Audit trail · alerts · keys": "Аудит-след · алерты · ключи",
  "state, outbox,": "состояние, outbox,",
  "audit log": "журнал аудита",
  "coin ledger,": "леджер — книга учёта",
  "double entry,": "с двойной записью,",
  "pending / post / void": "pending / post / void",
  "No transaction spans the two stores: PostgreSQL first, then the ledger with a fixed transfer id.":
    "Общей транзакции у двух хранилищ нет: сначала PostgreSQL, потом леджер с заранее известным id перевода.",
  // architecture: ports and adapters
  "Ports and adapters around one domain": "Порты и адаптеры вокруг одного домена",
  Domain: "Домен",
  "knows no casino and no database": "не знает ни казино, ни базы данных",
  "Grant policy": "Политика начисления",
  "deposit → spins": "депозит → вращения",
  "one confirm()": "один confirm()",
  Wheel: "Колесо",
  "the server picks the prize": "приз выбирает сервер",
  "Redemption: an intent": "Заявка на бонус",
  "created → reserved": "создана → монеты зарезервированы",
  "→ submitting": "→ отправлена",
  "→ issued | refused": "→ выдана | отказ",
  "the only way to a final status": "единственный путь к итогу",
  Port: "Порт",
  "Adapter A": "Адаптер A",
  "Adapter B": "Адаптер B",
  "answers at once,": "отвечает сразу,",
  "idempotency key": "ключ идемпотентности",
  "accepts, result": "принимает, результат",
  "by webhook, no": "вебхуком, без ключа",
  "idempotency key ": "идемпотентности",
  "token, sign-in, roles": "токен, вход, роли",
  simulated: "поддельное",
  "events in; reward request and look-up out": "внутрь: события; наружу: бонус и запрос статуса",
  "Player page": "Страница игрока",
  "Back office": "Бэк-офис",
  "TigerBeetle adapter": "Адаптер TigerBeetle",
  "double-entry ledger": "леджер с двойной записью",
  "state, outbox (leases),": "состояние, outbox (аренда),",
  "audit trail": "аудит-след",
  "Outbox → workers": "Outbox → воркеры",
  "(scale by count): every call to a casino or the ledger runs as a job":
    "масштабируются числом; каждый вызов наружу — задание",
  "One domain, one adapter per platform. Both casinos end in the same three outcomes: issued, refused, not known yet.":
    "Один домен, по адаптеру на платформу. Оба казино приходят к одним трём исходам: выдано, отказано, пока неизвестно.",
  // lifecycle
  "The life of a redemption": "Жизнь заявки на бонус",
  "Coins are held, not spent, until the casino answers": "Монеты замораживаются, а не списываются, пока казино не ответит",
  "intent + job": "намерение + задание",
  "coins held": "монеты заморожены",
  "asking the casino": "спрашиваем казино",
  final: "итог",
  "coins captured": "монеты списаны",
  "coins released": "монеты возвращены",
  // footage parts and captions
  "It works · Alpha": "Работает · Alpha",
  "It works · Beta": "Работает · Beta",
  "The casino reports a deposit. The player gets a spin.": "Казино сообщает о депозите. Игрок получает спин.",
  "The server picks the prize. The wheel only shows it.": "Приз выбирает сервер. Колесо его только показывает.",
  "The coins are credited in the ledger.": "Монеты зачислены в леджер.",
  "The player takes a bonus. Alpha answers at once.": "Игрок берёт бонус. Alpha отвечает сразу.",
  "Issued: the bonus is in the casino account.": "Выдан: бонус на счёте в казино.",
  "Same widget, the other casino: Beta, platform B.": "Тот же виджет, другое казино: Beta, платформа B.",
  "Deposit, spin, coins. Same domain model.": "Депозит, спин, монеты. Та же доменная модель.",
  "Beta accepts the request: “on its way”, coins on hold.": "Beta приняла запрос: «в пути», монеты заморожены.",
  "The result arrives by webhook: in the casino account.": "Результат приходит вебхуком: бонус на счёте.",
  "It survives failure": "Переживает сбой",
  "The casino issues the bonus, but its answer is lost": "Казино выдаёт бонус, но его ответ теряется",
  Failure: "Сбой",
  "On the fake casino panel: switch the fault on.": "В панели поддельного казино включаем сбой.",
  "The player takes a bonus. The answer never comes back.": "Игрок берёт бонус. Ответ так и не приходит.",
  "We ask the casino, find the bonus, mark it issued.": "Делаем запрос статуса, находим бонус, отмечаем выдачу.",
  "Audit trail": "Аудит-след",
  "The back office shows this redemption: issued, settled.": "Бэк-офис показывает эту заявку: бонус выдан, монеты списаны.",
  "Audit trail: the issue call failed, the look-up found the bonus.": "Аудит-след: выдача упала, запрос статуса нашёл бонус.",
  Check: "Проверка",
  "The casino's own record: one bonus per reference.": "Записи самого казино: по одному бонусу на заявку.",
  "We charged the player once. Every check passed.":
    "Ответ потерялся. Мы спросили казино, нашли бонус и списали монеты один раз.",
  Operations: "Эксплуатация",
  "Back office: real sign-in, roles per tenant.": "Бэк-офис: настоящий вход, роли в каждом казино.",
  "Overview: players, redemptions, jobs, alerts.": "Обзор: игроки, заявки, задания, алерты.",
  "Settings → Keys: replace a tenant's signing key.": "Настройки → Ключи: замена ключа подписи казино.",
  "The new key is shown once (blurred here).": "Новый ключ показывается один раз (здесь размыт).",
  // evidence
  Evidence: "Доказательства",
  "Measured and tested, not estimated": "Измерено и проверено, а не оценено на глаз",
  "500 redemptions, 64 at once. Time from the last request to the last final answer:":
    "500 заявок, по 64 одновременно. Время от последнего запроса до последнего итогового ответа:",
  "1 worker": "1 воркер",
  "2 workers": "2 воркера",
  "4 workers": "4 воркера",
  "7.1 s": "7,1 с",
  "3.4 s": "3,4 с",
  "1.8 s": "1,8 с",
  "All 1500 ended issued, none twice. One run per row, busy machine (docs/performance.md).":
    "Все 1500 выданы, ни одной дважды. Один прогон на строку, машина под нагрузкой (docs/performance.md).",
  "369 backend tests and 105 web tests, all green.": "369 серверных тестов и 105 веб-тестов, все зелёные.",
  "A fake casino that loses answers; a judge that reads only the casino's record and the ledger.":
    "Поддельное казино теряет ответы. Судья смотрит только в записи казино и в леджер.",
  "Mutation checks: the code is broken on purpose and the tests must fail.":
    "Мутационные проверки: код ломают нарочно, тесты обязаны упасть.",
  "CI runs the tests and starts the compose stack.": "CI гоняет тесты и поднимает весь compose-стек.",
  // how it was made
  "How it was made": "Как это сделано",
  "One engineer, one day, AI agents doing the typing": "Один инженер, один день, код набирают ИИ‑агенты",
  "AI agents worked from written briefs, each in its own branch.": "ИИ‑агенты работали по письменным заданиям, каждый в своей ветке.",
  "Product and design decisions were made by the engineer.": "Решения о продукте и архитектуре принимал инженер.",
  "Every change has a row in the decision log: who decided, how it was checked.":
    "У каждого изменения есть строка в журнале решений: кто решил и как проверено.",
  // close
  "Where the prototype ends": "Где заканчивается прототип",
  "Everything the task asks is built and tested": "Всё, что просит задание, построено и проверено тестами",
  "Simulated, as the task asks: both casino platforms.": "Поддельное, как и просит задание: обе платформы казино.",
  "Outside the task, for production: database-level tenant isolation, a secrets store, schema migrations, delivery of alerts.":
    "За рамками задания, для прода: изоляция казино на уровне базы, хранилище секретов, миграции схемы, доставка алертов.",
  "Outside the task, product decisions not made yet: missions, coin expiry, revoking a reward.":
    "За рамками задания, решения по продукту ещё не приняты: миссии, сгорание монет, отзыв бонуса.",
  "Honest close": "Что не сделано",
  "What is simulated and what is not built": "Что поддельное и что не построено",
  "Simulated: both casino platforms (one fake process with faults on demand).":
    "Поддельное: обе платформы казино (один процесс, сбои по запросу).",
  "Not built: missions and other mechanics, coin expiry, revoking a reward.":
    "Не построено: миссии и другие механики, сгорание монет, отзыв бонуса.",
  "Not built: rate limiting, alert delivery, database-enforced tenant isolation.":
    "Не построено: ограничение частоты запросов, доставка алертов, изоляция казино на уровне базы.",
};

export function useTr() {
  const lang = useContext(LangContext);
  return (en: string) => (lang === "ru" ? (RU[en] ?? en) : en);
}
