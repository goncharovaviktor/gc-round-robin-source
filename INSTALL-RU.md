# Установка через GitHub и Deploy to Cloudflare — без терминала

Эта инструкция рассчитана на Cloudflare Workers Free и установку только через
интерфейсы GitHub и Cloudflare. Командная строка не нужна.

## Что будет создано автоматически

Кнопка Deploy to Cloudflare прочитает `wrangler.jsonc` и создаст в выбранном
аккаунте:

- Worker `gc-manager-round-robin`;
- D1-базу `gc-manager-round-robin`;
- SQLite Durable Object `PoolAllocator`;
- рабочую очередь `gc-manager-rr-write`;
- аварийную очередь `gc-manager-rr-dlq`;
- Cron раз в пять минут;
- таблицы D1 из папки `migrations`.

Cloudflare официально поддерживает автоматическое создание D1, Durable
Objects и Queues через Deploy button. Репозиторий-источник при этом должен быть
публичным:

- [Deploy to Cloudflare buttons](https://developers.cloudflare.com/workers/platform/deploy-buttons/)
- [Workers Builds](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/)

## 1. До установки

1. Остановите массовый процесс распределения в GetCourse.
2. Старый Apps Script и Google-таблицу пока не удаляйте.
3. Выпишите последний фактически выданный `manager_code` каждого сегмента.
4. Подготовьте системный адрес школы без пути и завершающего `/`, например:

   ```text
   https://school.getcourse.ru
   ```

5. Подготовьте API-ключ GetCourse, который может обновлять пользователей.
6. Распакуйте ZIP. Работайте с папкой
   `gc-manager-round-robin-cloudflare-v2.1.0`.

## 2. Создать два секрета без сайта и терминала

1. Дважды щёлкните локальный файл `SECRET-GENERATOR.html`.
2. Нажмите **«Создать новые секреты»**.
3. Сохраните отдельно значения `WEBHOOK_SECRET` и `ADMIN_TOKEN` в менеджере
   паролей.
4. Не отправляйте эти значения в чат и не добавляйте в GitHub.

Страница работает локально и ничего не отправляет в интернет. API-ключ
GetCourse также будет введён только в защищённое поле Cloudflare.

## 3. Проверить список сегментов и менеджеров

Откройте файл `src/manager-config.js` любым текстовым редактором.

Для каждого сегмента есть блок:

```js
{
  pool: "segment_1",
  initialLastManagerCode: "",
  managers: [
    { code: "s1_manager_1", name: "Менеджер 1", active: true },
    { code: "s1_manager_2", name: "Менеджер 2", active: true }
  ]
}
```

Проверьте следующее:

- `pool` точно совпадает со значением, которое будет отправлять этот сегмент
  GetCourse;
- `code` точно совпадает с условием соответствующей ветки GetCourse;
- порядок строк — это порядок round-robin;
- ненужные строки удалены;
- временно исключённому менеджеру поставлено `active: false`;
- в каждом пуле остался хотя бы один `active: true`;
- `name` можно оставить нейтральным (`Менеджер 1`): это поле не участвует в
  назначении и тогда в публичном GitHub не будет ФИО.

Если нужно продолжить старую очередь, впишите в `initialLastManagerCode` код,
который был выдан последним. Например, после `s1_manager_3` следующий запрос
получит `s1_manager_4`. Если оставить пустую строку, первым станет первый
активный менеджер.

При первой установке оставьте:

```js
version: 1
```

При любом будущем изменении этого файла увеличивайте версию на единицу. Если
изменить содержимое и забыть увеличить версию, Worker намеренно остановит
распределение с `ERROR_MANAGER_CONFIG_VERSION_REUSED`, а не применит
сомнительную конфигурацию молча.

## 4. Заполнить безопасные настройки Worker

Откройте `wrangler.jsonc`.

1. Замените:

   ```text
   https://YOUR-SCHOOL.getcourse.ru
   ```

   на системный адрес вашей школы.

2. Проверьте название дополнительного поля:

   ```json
   "GC_MANAGER_CODE_FIELD": "manager_code"
   ```

3. Только после проверки `src/manager-config.js` замените:

   ```json
   "MANAGER_CONFIG_READY": "false"
   ```

   на:

   ```json
   "MANAGER_CONFIG_READY": "true"
   ```

4. Не меняйте нулевой `database_id`. Deploy button сам создаст D1 и подставит
   реальный ID в созданный им репозиторий.
5. Не добавляйте в этот файл API-ключ или секреты.

## 5. Загрузить комплект в GitHub

Deploy button работает только с публичным GitHub/GitLab-репозиторием. Код не
содержит паролей или персональных данных; реальные секреты будут храниться в
Cloudflare. Если названия менеджеров конфиденциальны, оставьте нейтральные
подписи.

1. Войдите в GitHub.
2. Нажмите **New repository**.
3. Назовите, например, `gc-round-robin-source`.
4. Выберите **Public**.
5. Не добавляйте GitHub README, `.gitignore` или лицензию автоматически.
6. Нажмите **Create repository**.
7. На пустой странице выберите **uploading an existing file** или
   **Add file → Upload files**.
8. Перетащите в окно всё содержимое распакованной папки, а не саму внешнюю
   папку.
9. Внизу нажмите **Commit changes**.

До Deploy обязательно убедитесь, что в корне GitHub видны:

- `package.json` и `package-lock.json`;
- `wrangler.jsonc`;
- `.dev.vars.example`;
- папки `src`, `migrations` и `test`;
- `src/manager-config.js` содержит вашу проверенную схему;
- в поиске репозитория нет настоящих значений `GC_API_KEY`,
  `WEBHOOK_SECRET`, `ADMIN_TOKEN`.

## 6. Запустить Deploy to Cloudflare

Скопируйте адрес публичного репозитория, например:

```text
https://github.com/USERNAME/gc-round-robin-source
```

Подставьте его в адрес:

```text
https://deploy.workers.cloudflare.com/?url=https://github.com/USERNAME/gc-round-robin-source
```

Откройте получившуюся ссылку в браузере.

На странице Cloudflare:

1. Авторизуйте GitHub, если Cloudflare попросит.
2. Выберите нужный Cloudflare-аккаунт.
3. Для конечного репозитория укажите, например,
   `gc-manager-round-robin-school`.
4. Имя Worker оставьте `gc-manager-round-robin`.
5. Имена ресурсов оставьте такими, как предложено проектом.
6. Проверьте команды, которые Cloudflare подставил автоматически:

   | Поле | Значение |
   |---|---|
   | Build command | `npm run build` |
   | Deploy command | `npm run deploy` |
   | Root directory | пусто |

7. В защищённые поля секретов вставьте:

   | Имя | Что вставить |
   |---|---|
   | `GC_API_KEY` | API-ключ GetCourse |
   | `WEBHOOK_SECRET` | первый секрет из локального генератора |
   | `ADMIN_TOKEN` | второй, отличный секрет |

8. Нажмите **Save and Deploy** / **Deploy**.

Cloudflare создаст отдельный конечный GitHub-репозиторий, ресурсы и запустит
сборку. Исходный `gc-round-robin-source` после успешной установки можно
удалить: дальнейшие изменения делаются в конечном репозитории, подключённом к
Worker.

## 7. Что должно быть в журнале первого Deploy

Откройте детали сборки и дождитесь зелёного статуса. В логе должны пройти:

1. проверка конфигурации;
2. 20 unit-тестов;
3. 13 интеграционных тестов Cloudflare;
4. применение `0001_initial.sql` и `0002_dead_letters.sql`;
5. публикация Worker.

Если тест или проверка не прошли, Worker не должен заменять рабочую версию.
Не отключайте `npm run build` ради обхода ошибки — найдите сообщение по таблице
ниже.

| Ошибка | Что исправить |
|---|---|
| `Replace YOUR-SCHOOL` | Исправить `GC_BASE_URL` в `wrangler.jsonc` |
| `MANAGER_CONFIG_READY` | Проверить список и поставить строку `true` |
| `CONFIG_...DUPLICATE` | Удалить повторный пул или повторный код менеджера |
| `CONFIG_INITIAL_MANAGER_UNKNOWN` | Исправить стартовый код: он должен присутствовать в списке этого пула |
| `CONFIG_NO_ACTIVE_MANAGERS` | Оставить хотя бы одного активного в пуле |
| миграция D1 не применена | Нажать Retry deployment; не создавать таблицы вручную |
| secret отсутствует | Добавить его по следующему разделу |

## 8. Если Deploy не предложил ввести секреты

Иногда мастер создаёт Worker, но секреты добавляются уже после первого Deploy.
Тогда:

1. Cloudflare Dashboard → **Workers & Pages**.
2. Откройте `gc-manager-round-robin`.
3. **Settings → Variables and Secrets**.
4. Добавьте три переменные типа **Secret / Encrypt**:
   `GC_API_KEY`, `WEBHOOK_SECRET`, `ADMIN_TOKEN`.
5. Для каждой вставьте соответствующее значение и сохраните.
6. Нажмите **Deploy** / **Save and deploy**, если интерфейс это предложит.

Не создавайте их как обычный открытый Text value.

## 9. Проверить созданные ресурсы

В Worker откройте **Settings → Bindings**. Должны присутствовать:

| Binding | Тип |
|---|---|
| `RR_DB` | D1 database |
| `POOL_ALLOCATOR` | Durable Object |
| `GC_WRITE_QUEUE` | Queue producer |
| `GC_WRITE_DLQ` | Queue producer |

В разделе Queues должны быть две очереди, а у обеих — consumer
`gc-manager-round-robin`. Для рабочей очереди `Max concurrency` должна быть
равна `1`.

## 10. Проверить `/health`

На странице Worker скопируйте адрес `workers.dev` и откройте:

```text
https://ВАШ_WORKER.workers.dev/health
```

Готовая система возвращает HTTP 200 и объект примерно такого вида:

```json
{
  "ok": true,
  "version": "2.1.0",
  "database_ready": true,
  "manager_configuration_ready": true,
  "manager_configuration_version": 1,
  "getcourse_configuration_ready": true,
  "admin_token_ready": true,
  "pools": [
    { "pool": "segment_1", "active_managers": 5, "total_managers": 5 }
  ]
}
```

Сверьте количество пулов и активных менеджеров. Возможные ответы:

| Ответ | Значение |
|---|---|
| `ERROR_MANAGER_CONFIG_NOT_READY` | в `wrangler.jsonc` осталось `false` |
| `ERROR_DATABASE_NOT_READY` | миграции D1 не завершились |
| `ERROR_MANAGER_CONFIG_VERSION_REUSED` | файл изменён без увеличения версии |
| `ERROR_NOT_CONFIGURED` | домен школы или один из трёх секретов не готов |

До `ok: true` не подключайте рабочий процесс GetCourse.

## 11. Проверить D1 через интерфейс Cloudflare

1. Cloudflare Dashboard → **Storage & Databases → D1**.
2. Откройте `gc-manager-round-robin`.
3. Откройте **Console**.
4. Вставьте и выполните:

   ```sql
   SELECT pool, manager_code, manager_name, active, sort_order
   FROM managers
   ORDER BY pool, sort_order;
   ```

Сверьте строки с ветками GetCourse. Это проверка чтения, она ничего не меняет.

## 12. Безопасное подключение GetCourse

Перейдите к `GETCOURSE-SETUP-RU.md`.

Порядок включения:

1. Создать копию блока процесса.
2. Ограничить её одним тестовым пользователем.
3. Пройти один запрос, полный круг и параллельный тест из
   `TEST-CHECKLIST-RU.md`.
4. Только затем переключить рабочие сегменты.
5. Старый Apps Script отключить, но не удалять минимум семь дней.

## 13. Обновления после установки — тоже без терминала

Cloudflare связан с конечным GitHub-репозиторием. Для изменения менеджеров:

1. В GitHub откройте `src/manager-config.js`.
2. Нажмите значок карандаша.
3. Измените список.
4. Увеличьте `version` на 1.
5. Нажмите **Commit changes** в ветку `main`.
6. В Cloudflare откройте **Deployments** и дождитесь зелёной сборки.
7. Снова проверьте `/health`.

Не изменяйте менеджеров напрямую в D1: при следующей версии конфигурации файл
GitHub является источником истины и синхронизирует таблицу атомарно.

## 14. Бесплатный тариф

При пустом Cloudflare-аккаунте весь бесплатный лимит доступен этой системе.
На Free Cloudflare Queues предоставляет 10 000 операций в сутки; обычное
успешное назначение обычно использует три операции. Это около 3 333 назначений
без повторов в теории. Для запаса на сбои придерживайтесь:

- до 2 000 назначений/сутки — комфортный рабочий диапазон;
- 2 000–2 500 — допустимо при контроле retries;
- выше 2 500 — лучше перейти на Paid.

Если дневной лимит Queue закончится, Worker не потеряет уже принятое задание:
оно останется в Durable Object outbox и будет повторяться с увеличивающейся
паузой до 15 минут. Но назначение задержится до восстановления лимита, поэтому
ветка `WAITING` и уведомление администратора обязательны.

Актуальные лимиты:

- [Queues pricing](https://developers.cloudflare.com/queues/platform/pricing/)
- [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)
- [Workers Builds limits](https://developers.cloudflare.com/workers/ci-cd/builds/limits-and-pricing/)
