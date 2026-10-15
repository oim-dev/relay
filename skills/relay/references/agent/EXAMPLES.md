# Пример работы через CLI

[Главная инструкция](../../SKILL.md). Все команды запускаются через `npx @oim-dev/relay-cli`.
Пример показывает путь от знаний к проверенной работе и выпуску. Учебное содержание
не является требованием к вашему проекту и не разрешает создавать демонстрационные записи в нём.

Команды рассчитаны на POSIX shell и выбранную local-базу. Для workspace добавляйте
`--project` и при необходимости `--config`/`--server-url` к каждой предметной команде.
Перед записью читайте существующие данные: пример создания предназначен для пустой учебной области.

## Подстановки и ответы

Переменные `$FEATURE_ID`, `$SCENARIO_ID`, `$APP_ID`, `$SI_ID`, `$TASK_ID`, `$PLAN_ID`,
`$STAGE_ID`, `$RELEASE_ID`, `$CRITERION_ID` заполняйте адресами из фактического вывода CLI:
для сущностей предпочитайте читаемые ключи (несмотря на суффикс `_ID`), для этапа
и критерия нужен внутренний ID. `$BOARD_REF` — проверенная доска приложения,
`$ACTOR` — согласованный автор. `$TASK_REVISION`, `$PLAN_REVISION`, `$RELEASE_REVISION` — ревизии
из свежего чтения перед соответствующим изменением; после записи прежние значения устаревают.
Читайте адрес и ревизию в результате команды или карточке, не угадывайте их по порядку создания.

Проверяйте код завершения и сообщения команд, читайте полный Markdown и продолжение списков.
Переменные обозначают места подстановки, а не автоматически подготовленное окружение.
Не запускайте весь пример без остановок на чтение, выполнение и проверку результата.
Потеря ответа требует проверки состояния, а не повторного исполнения цепочки.

## 1. Сохраните знания

Вымышленное ТЗ: пользователь открывает каталог и видит записи либо пустое состояние.
Исходный текст сохраняется сразу, до задач и планирования:

```bash
# relay-example: document
npx @oim-dev/relay-cli document create \
  --actor "$ACTOR" \
  --name 'Учебное ТЗ' \
  --document-kind specification \
  --body '## Требование

Пользователь открывает каталог и видит записи либо пустое состояние.

## Границы учебного примера

Описывается только чтение каталога. Создание, редактирование, поиск и фильтры не входят.
Состав полей записи и поведение при отказе источника данных требуют уточнения до разработки.

## Проверка

Проверить непустой и пустой наборы. Это инструкция проверки, а не подтверждение результата.'
```

Создайте паспорт, фичу и сценарий. В работающей памяти найдите и обновите существующих владельцев.

```bash
# relay-example: product
npx @oim-dev/relay-cli product create \
  --actor "$ACTOR" \
  --name 'Учебный каталог' \
  --summary 'Пример подготовки знаний' \
  --description '## Назначение

Пользователь просматривает каталог и понимает, есть ли в нём записи.

## Границы

Первый объём — чтение. Создание, редактирование, поиск и фильтры не входят.
Основание — документ «Учебное ТЗ».

## Неизвестное

До разработки уточнить состав полей записи и поведение при отказе источника данных.'
```

```bash
# relay-example: feature
npx @oim-dev/relay-cli feature create \
  --actor "$ACTOR" \
  --name 'Просмотр каталога' \
  --description '## Поведение

Показать пользователю записи каталога. При пустом каталоге объяснить отсутствие данных.

## Границы и основания

Требование взято из документа «Учебное ТЗ». Фича не включает изменение записей,
поиск или фильтры. В сценарии «Открыть каталог» раскрывается путь чтения.

## Проверяемый результат

Непустой набор отображается как записи, пустой — как объяснение отсутствия данных.
Состав отображаемых полей и обработка отказа источника пока не определены:
эти вопросы нужно решить до реализации, а не считать пустым результатом.'
```

```bash
# relay-example: scenario
npx @oim-dev/relay-cli scenario create \
  --actor "$ACTOR" \
  --feature "$FEATURE_ID" \
  --name 'Открыть каталог' \
  --description '## Участник и условия

Пользователь открывает каталог. Основание — фича «Просмотр каталога» и учебное ТЗ.

## Основной путь

1. Пользователь переходит на экран каталога.
2. Приложение получает набор записей.
3. При непустом наборе показывает записи; при пустом — объясняет отсутствие данных.

## Результат и открытые вопросы

Пользователь различает наличие записей и их отсутствие. До разработки нужно определить
состав полей, состояние ожидания и реакцию на отказ источника; из ТЗ они не следуют.'
```

Создайте приложение и его вклад в общую фичу и сценарий. SI требует FI той же фичи и приложения.

```bash
# relay-example: application
npx @oim-dev/relay-cli application create \
  --actor "$ACTOR" \
  --name 'Web' \
  --slug web \
  --type frontend \
  --description '## Ответственность

Web предоставляет пользователю экран чтения каталога и отображает полученный набор.

## Границы и взаимодействие

Создание и изменение записей не входят в приложение этого учебного объёма.
Источник данных и контракт взаимодействия ещё не согласованы; не вводить собственное
хранилище или API без уточнения.

## Результат

Приложение различает непустой и пустой наборы согласно связанной фиче.'
```

```bash
# relay-example: fi
npx @oim-dev/relay-cli implementation create \
  --actor "$ACTOR" \
  --application "$APP_ID" \
  --target "$FEATURE_ID" \
  --title 'Каталог в Web' \
  --description '## Ответственность

Web отвечает за представление фичи «Просмотр каталога»: экран с записями либо
объяснением отсутствия данных. Получение и отображение раскрываются в выбранной SI.

## Границы

Не включает создание, изменение, поиск и фильтры. Общие требования хранятся в фиче;
эта FI задаёт обязательства интерфейса, а не отдельные правила продукта.

## Проверка и вопросы

Проверить выполнение выбранной SI на непустом и пустом наборах.
До разработки согласовать источник, состав полей, ожидание и обработку ошибок.'
```

```bash
# relay-example: si
npx @oim-dev/relay-cli implementation create \
  --actor "$ACTOR" \
  --application "$APP_ID" \
  --target "$SCENARIO_ID" \
  --title 'Открытие каталога в Web' \
  --description '## Ответственность и основания

Web реализует сценарий «Открыть каталог» по фиче «Просмотр каталога» и учебному ТЗ.

## Поведение и данные

- При открытии экрана получить набор записей из согласованного источника.
- При непустом наборе отобразить записи с согласованными полями.
- При пустом наборе показать понятное сообщение об отсутствии данных.

## Границы и неизвестное

Редактирование данных не входит. Источник, поля, ожидание и ответ на ошибку ещё
не определены: до реализации уточнить требования, не подменять ошибку пустым набором.

## Проверка

На контролируемом непустом наборе сверить показанные записи с входом.
На пустом наборе проверить сообщение об отсутствии данных. Ошибочный путь проверять
после согласования его поведения; сейчас он не считается описанным или проверенным.'
```

Прикрепите исходное ТЗ. `$DOCUMENT_ID` — ключ документа, `$DOCUMENT_REVISION` — его свежая
ревизия. Предметный `document link` сохраняет остальные отношения документа.

```bash
# relay-example: document-read
npx @oim-dev/relay-cli document get "$DOCUMENT_ID"
```

```bash
# relay-example: attach
npx @oim-dev/relay-cli document link "$DOCUMENT_ID" \
  --actor "$ACTOR" \
  --target "$SCENARIO_ID" \
  --relation references \
  --description 'Основание сценария' \
  --if-revision "$DOCUMENT_REVISION"
```

```bash
# relay-example: document-check
npx @oim-dev/relay-cli document get "$DOCUMENT_ID"
```

```bash
# relay-example: document-links-check
npx @oim-dev/relay-cli document links "$DOCUMENT_ID"
```

## 2. Организуйте работу

Создайте задачу с целью SI и проверяемым критерием. Её доска принадлежит приложению Web.

```bash
# relay-example: task
npx @oim-dev/relay-cli task create \
  --actor "$ACTOR" \
  --board "$BOARD_REF" \
  --title 'Реализовать просмотр каталога' \
  --description '## Цель

Выполнить связанный сценарий и проверить пустое состояние.

## Основания и подготовка

Прочитать SI «Открытие каталога в Web», фичу и прикреплённое учебное ТЗ.
До разработки согласовать открытые вопросы SI и сохранить ответы в требованиях.

## Объём и границы

Реализовать получение и отображение записей и пустое состояние по уточнённой SI.
Создание, изменение, поиск и фильтры не входят.

## Проверка

Сверить непустой набор и пустое состояние. После уточнения проверить ожидание и ошибки.
Сохранить реальные результаты и ограничения; выполнение команд этого примера не реализует экран.' \
  --targets "$SI_ID" \
  --criterion-title 'catalog=Каталог и пустое состояние соответствуют ТЗ'
```

Пример использует план из одной задачи. Это допустимый объём, а не требование создавать
план для каждого действия. Создайте план, прочитайте его, добавьте этап, затем перечитайте
ревизию и явно включите задачу. `$STAGE_ID` получите через `plan stage list` после создания этапа.

```bash
# relay-example: plan
npx @oim-dev/relay-cli plan create \
  --actor "$ACTOR" \
  --title 'Просмотр каталога' \
  --goal '## Цель

Доставить проверенный сценарий просмотра каталога в Web.

## Границы и результат

Включить задачу реализации; сначала закрыть вопросы требований, затем выполнить
и проверить сценарий. Итог должен содержать фактические проверки и ограничения.'
```

```bash
# relay-example: plan-read
npx @oim-dev/relay-cli plan get "$PLAN_ID"
```

```bash
# relay-example: stage
npx @oim-dev/relay-cli plan stage create "$PLAN_ID" \
  --actor "$ACTOR" \
  --title 'Реализация и проверка' \
  --if-revision "$PLAN_REVISION"
```

```bash
# relay-example: plan-reread
npx @oim-dev/relay-cli plan get "$PLAN_ID"
```

```bash
# relay-example: stage-list
npx @oim-dev/relay-cli plan stage list "$PLAN_ID"
```

```bash
# relay-example: include
npx @oim-dev/relay-cli plan stage task add "$PLAN_ID" "$STAGE_ID" \
  --actor "$ACTOR" \
  --tasks "$TASK_ID" \
  --if-revision "$PLAN_REVISION"
```

```bash
# relay-example: scope-check
npx @oim-dev/relay-cli plan stage task list "$PLAN_ID" "$STAGE_ID"
```

## 3. Выполните и проверьте

Прочитайте задачу и начните порученную работу:

```bash
# relay-example: task-read
npx @oim-dev/relay-cli task get "$TASK_ID"
```

```bash
# relay-example: start
npx @oim-dev/relay-cli task move "$TASK_ID" \
  --actor "$ACTOR" \
  --column in-progress \
  --if-revision "$TASK_REVISION"
```

Здесь выполняются разработка и проверки внешними средствами. `$OBSERVED_RESULT` —
реальный Markdown-отчёт: сделанное, команды/сценарии проверок, их результат, основания,
ограничения и следующий шаг. Сохраните его независимо от успешности проверки:

```bash
# relay-example: evidence
npx @oim-dev/relay-cli task comment add "$TASK_ID" \
  --actor "$ACTOR" \
  --title 'Результат проверки' \
  --description "$OBSERVED_RESULT" \
  --role worker
```

**Если проверка не пройдена или не выполнена, остановите здесь путь завершения.**
Оставьте задачу в работе, сохраните причину и следующий шаг. Далее показана успешная
ветка при порученном завершении; если нужна приёмка другим участником, сначала передайте результат ему.

Получите ID нужного критерия и актуальную ревизию задачи; отмечайте только проверенный критерий:

```bash
# relay-example: criteria
npx @oim-dev/relay-cli task criterion list "$TASK_ID"
```

```bash
# relay-example: task-before-criterion
npx @oim-dev/relay-cli task get "$TASK_ID"
```

```bash
# relay-example: criterion
npx @oim-dev/relay-cli task criterion complete "$TASK_ID" "$CRITERION_ID" \
  --actor "$ACTOR" \
  --if-revision "$TASK_REVISION"
```

```bash
# relay-example: task-before-done
npx @oim-dev/relay-cli task get "$TASK_ID"
```

```bash
# relay-example: done
npx @oim-dev/relay-cli task move "$TASK_ID" \
  --actor "$ACTOR" \
  --column done \
  --if-revision "$TASK_REVISION"
```

## 4. Завершите план и зафиксируйте поставку

Проверьте прогресс; при невыполненном составе читайте причины и не завершайте план.
Для готового состава перечитайте ревизию и сохраните фактический итог:

```bash
# relay-example: progress
npx @oim-dev/relay-cli plan progress "$PLAN_ID"
```

```bash
# relay-example: plan-before-complete
npx @oim-dev/relay-cli plan get "$PLAN_ID"
```

```bash
# relay-example: complete
npx @oim-dev/relay-cli plan complete "$PLAN_ID" \
  --actor "$ACTOR" \
  --if-revision "$PLAN_REVISION" \
  --result "$OBSERVED_RESULT"
```

**Следующие действия выполняйте при порученном выпуске и подтверждённой внешней поставке.**
`$RELEASE_VERSION` — её обозначение, `$DEPLOYMENT_EVIDENCE` — реальные основания.
Пример не выполняет публикацию или развёртывание вместо пользователя.

```bash
# relay-example: release
npx @oim-dev/relay-cli release create \
  --actor "$ACTOR" \
  --title 'Учебный выпуск' \
  --release-version "$RELEASE_VERSION" \
  --plans "$PLAN_ID" \
  --description "$DEPLOYMENT_EVIDENCE"
```

```bash
# relay-example: release-read
npx @oim-dev/relay-cli release get "$RELEASE_ID"
```

```bash
# relay-example: publish
npx @oim-dev/relay-cli release publish "$RELEASE_ID" \
  --actor "$ACTOR" \
  --if-revision "$RELEASE_REVISION"
```

```bash
# relay-example: release-check
npx @oim-dev/relay-cli release get "$RELEASE_ID"
```

При продолжении после паузы читайте задачу, комментарии, требования и состав плана
заново. Прежний комментарий не доказывает свежую проверку. Единый рабочий процесс —
в [главном руководстве](../../SKILL.md), точный синтаксис — в [CLI](../interfaces/CLI.md).

## 5. История агента и субагента

Этот отдельный пример показывает протокол участия, а не требует повторить уже
выполненную работу выше. Проверьте доступность команд через `session --help` и
`checkpoint --help`. Правила — [история работы](../domain/WORK_HISTORY.md).
Используйте тестовую область либо реальное поручение; не создавайте учебные ветки
в пользовательской базе без разрешения. Server для человека уже должен быть доступен.

### Начало и намерение

```bash
npx @oim-dev/relay-cli session list --unfinished --limit 10
```

Для нового поручения:

```bash
npx @oim-dev/relay-cli session start \
  --actor "$ACTOR" \
  --user-name "$USER_NAME" \
  --user-email "$USER_EMAIL" \
  --title 'Проверить сохранение Markdown' \
  --description-file ./assignment.md
```

Не запускайте start, если поручено продолжить существующую ветку: прочитайте её get,
отдельный список открытых намерений через `session intents`, затем context/history
и выберите attach, resume или согласованный takeover по состоянию. Иначе старое открытое
намерение может потеряться среди новых закрытых. `projectTotals` не зависит от страницы
и фильтров, `total` считает отфильтрованные ветки, latestRun сохраняется и после закрытия.
`$USER_NAME`/`$USER_EMAIL` — согласованный человек, не имя агента и не автор последнего
коммита. Можно опустить оба флага: CLI выберет пару из RELAY_USER_NAME/RELAY_USER_EMAIL,
затем Git-конфигурации текущего каталога внутри репозитория. Частичная пара не дополняется
из другого источника. Git-ветка и commit снимаются отдельно; неизвестное остаётся null.

Для продолжения `$SESSION_REF` — фактический ключ или ID выбранной ветки из списка:

```bash
npx @oim-dev/relay-cli session get "$SESSION_REF"
npx @oim-dev/relay-cli session intents "$SESSION_REF" --include-children --limit 10
npx @oim-dev/relay-cli session context "$SESSION_REF" --limit 10
```

Здесь `--include-children` выбирает также намерения всех потомков; это чтение,
не передача их владения. Следуйте `--cursor` или готовой команде продолжения.
Затем явно подключитесь или возобновите выбранную работу. Следующие шаги примера
относятся к новой корневой ветке и отдельной дочерней проверке.

Из фактического ответа возьмите `$ROOT_REF` (ключ или ID ветки), `$ROOT_RUN_ID`
(постоянный `run.id`) и `$ROOT_REVISION` (ревизия ветки). Адреса случайные, не угадывайте
следующий номер. `assignment.md` должен содержать полное поручение, границы и критерии.

````bash
npx @oim-dev/relay-cli checkpoint open "$ROOT_REF" \
  --actor "$ACTOR" --run "$ROOT_RUN_ID" --if-revision "$ROOT_REVISION" \
  --title 'Намерение: проверить полный Markdown' --body-file - <<'MD'
## Цель

Проверить сохранность полного многострочного материала через выбранный CLI.

## Проверка

- Прочитать точку целиком через checkpoint get.
- Сравнить заголовки, списки, пустые строки и код, а не только аннотацию списка.

```text
  Отступ внутри блока должен сохраниться.
```

## Границы

Эта проверка не доказывает доступность Web или успешность внешней разработки.
MD
````

Сохраните `$ROOT_INTENT_REF` и новую ревизию. `checkpoint get "$ROOT_INTENT_REF"`
должен показать весь материал. До каждого изменения обновляйте `$ROOT_REVISION`
из результата или `session get`; не подставляйте старую ревизию к новой операции.

### Родитель создаёт ветку до запуска

```bash
npx @oim-dev/relay-cli session fork "$ROOT_INTENT_REF" \
  --actor "$ACTOR" --run "$ROOT_RUN_ID" --if-revision "$ROOT_REVISION" \
  --title 'Независимо проверить сохранённый материал' \
  --description-file ./child-assignment.md
```

Из `childSession` получите `$CHILD_REF` и постоянный `$CHILD_ID`. После fork ребёнок
pending, run у него ещё нет. Только теперь запускайте разрешённого субагента,
передав в prompt:

- выбранный проект, реальный config и local/HTTP-подключение;
- `$CHILD_REF`, `$ROOT_INTENT_REF`, задачу и документы-основания;
- назначение, границы, критерии, файлы/ресурсы и контекст человека-оператора;
- обязанность attach, собственного intent, результата и передачи refs родителю.

Субагент проверяет проект и полное поручение, затем:

```bash
npx @oim-dev/relay-cli session get "$CHILD_REF"
npx @oim-dev/relay-cli checkpoint get "$ROOT_INTENT_REF"
npx @oim-dev/relay-cli session attach "$CHILD_REF" \
  --actor "$CHILD_ACTOR" --if-revision "$CHILD_REVISION"
```

Без явных user-флагов и RELAY_USER_* attach наследует оператора родительского участия,
создавшего ветку; Git-конфигурация ребёнка его не заменяет. Явная/env-пара переопределяет
наследование. Сверьте сохранённый снимок. Получите собственный `$CHILD_RUN_ID`, затем
свежие ревизии ребёнка перед каждым действием:

```bash
npx @oim-dev/relay-cli checkpoint open "$CHILD_REF" \
  --actor "$CHILD_ACTOR" --run "$CHILD_RUN_ID" --if-revision "$CHILD_REVISION" \
  --title 'Намерение независимой проверки' --body-file ./child-intent.md
```

Возьмите `$CHILD_INTENT_REF`. Выполните порученную проверку; на смысловой границе
сохраните фактические наблюдения, не выдуманный успешный результат:

```bash
npx @oim-dev/relay-cli checkpoint save "$CHILD_INTENT_REF" \
  --actor "$CHILD_ACTOR" --run "$CHILD_RUN_ID" --if-revision "$CHILD_REVISION" \
  --title 'Промежуточные наблюдения' --body-file ./child-progress.md
```

Дальнейшее завершение допустимо только при выполненном поручении. Полный итог и
ограничения запишите в `child-result.md`, фактические проверки — в `child-checks.md`.
После каждой записи используйте новую ревизию **ветки**:

```bash
npx @oim-dev/relay-cli checkpoint complete "$CHILD_INTENT_REF" \
  --actor "$CHILD_ACTOR" --run "$CHILD_RUN_ID" --if-revision "$CHILD_REVISION" \
  --title 'Результат независимой проверки' \
  --body-file ./child-result.md --checks-file ./child-checks.md
npx @oim-dev/relay-cli session get "$CHILD_REF"
```

```bash
npx @oim-dev/relay-cli session complete "$CHILD_REF" \
  --actor "$CHILD_ACTOR" --run "$CHILD_RUN_ID" --if-revision "$CHILD_REVISION" \
  --result-file ./child-result.md
```

Передайте родителю адреса и ограничения. Completed ребёнка ещё не означает принятия.

### Принятие и завершение родителя

Родитель читает итог и нужные полные материалы; `--limit` ограничивает страницу,
не сокращает Markdown полученной точки. Следуйте продолжению при необходимости:

```bash
npx @oim-dev/relay-cli session get "$CHILD_REF"
npx @oim-dev/relay-cli session context "$CHILD_REF" --limit 10
npx @oim-dev/relay-cli session get "$ROOT_REF"
```

После проверки сохраните основание приёмки в `acceptance.md`. `--accept` получает
**постоянный session.id**, не читаемый ключ ребёнка. Если есть нерешённые замечания,
сначала организуйте доработку, не исполняйте успешную ветку ниже:

```bash
npx @oim-dev/relay-cli checkpoint save "$ROOT_INTENT_REF" \
  --actor "$ACTOR" --run "$ROOT_RUN_ID" --if-revision "$ROOT_REVISION" \
  --title 'Принят результат ребёнка' --body-file ./acceptance.md \
  --accept "$CHILD_ID"
```

Завершите исходное намерение отдельной точкой и всю ветку с итогом. Снова обновите
`$ROOT_REVISION` после каждой записи; `root-result.md` содержит сделанное, проверки,
ограничения и оставшиеся ресурсы, а не только «готово»:

```bash
npx @oim-dev/relay-cli checkpoint complete "$ROOT_INTENT_REF" \
  --actor "$ACTOR" --run "$ROOT_RUN_ID" --if-revision "$ROOT_REVISION" \
  --title 'Проверка завершена' --body-file ./root-result.md
npx @oim-dev/relay-cli session get "$ROOT_REF"
```

```bash
npx @oim-dev/relay-cli session complete "$ROOT_REF" \
  --actor "$ACTOR" --run "$ROOT_RUN_ID" --if-revision "$ROOT_REVISION" \
  --result-file ./root-result.md
npx @oim-dev/relay-cli session tree "$ROOT_REF" --limit 10
```

Вместо завершения незаконченной работы сохраните остаток и выполните pause с причиной.
После обрыва прочитайте историю и реальный проект; resume/takeover создают новый run,
старое авторство сохраняется. Takeover корня не передаёт детей. При независимой работе
двух людей в разных Git-ветках сохраняйте разные сессии; после merge выполняйте явные
reindex и doctor check. Конфликт постоянных файлов одной сессии требует согласования,
не автоматического выбора по ревизии. Полный порядок — [восстановление](../guides/RECOVERY.md).
