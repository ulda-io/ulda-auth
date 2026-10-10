# Публикация ulda-auth: инструкция сопровождающему

Статус 10.10.2026: подготовка локального 1.0.0; GitHub push и npm publish не выполнены.
Выбран адрес ulda-io/ulda-auth. Имя пакета ulda-auth, отдельная лицензия SDK и
mark@shaposhnik.ch подтверждены владельцем. Команды ниже — действия будущего выпуска.

## 1. Пустой GitHub-репозиторий

В GitHub выберите владельца **ulda-io**, имя **ulda-auth**. Не добавляйте README,
.gitignore или шаблон лицензии: они уже есть локально, включая собственную лицензию.
Членство в организации не всегда даёт право создавать репозитории — это зависит от её
настроек. Публичность выберите при согласованной публикации; приватный repo допускает
предварительную проверку CI. Затем проверьте доступ и адрес origin из каталога SDK:

~~~powershell
git remote -v
gh repo view ulda-io/ulda-auth
git status --short
~~~

Если origin отсутствует, добавьте https://github.com/ulda-io/ulda-auth.git.
Перед push проверьте состав текущего коммита и отчёт о Git-истории. Этот репозиторий начинает новую историю с одного корневого коммита. История прототипа,
локальные дневники, старые отчёты, vendor-архив и сайт-стенд сюда не перенесены.
.local, node_modules, dist, логи, .npmrc и .env не отслеживаются и обычным push не передаются.

После решения о выгрузке текущей ветки в основную:

~~~powershell
git push -u origin HEAD:main
~~~

Не используйте --mirror, --all или --force: для первого выпуска нужна выбранная ветка
с её предками. Дождитесь SDK checks: Node 22/24 × Windows/Linux. В настройках GitHub
включите Private vulnerability reporting; после проверки обновите статус канала в
SECURITY.md. Если меняется файл из пакета, повторите приёмку и получите новый SHA.

## 2. Финальный артефакт

~~~powershell
npm ci --ignore-scripts
npm run release:check
npm run test:package -- http://127.0.0.1:3000
npm run test:browser
npm run test:publish
~~~

Backend должен быть локальным ULDA Server с нужным протоколом. Все четыре receipts
в .local/release должны относиться к одному SHA-256; сохраните их в приватном журнале выпуска; сырые тестовые логи не публикуйте.
Проверьте release limits в [RELEASE.md](RELEASE.md). Версия без rc не снимает эти ограничения.
Не публикуйте по результату старого архива после изменения package.json или документации.

## 3. Вход и публикация в npm

Права GitHub-организации не дают прав npm. Вход выполняется владельцем интерактивно:

~~~powershell
npm login --auth-type=web --registry=https://registry.npmjs.org/
npm whoami --registry=https://registry.npmjs.org/
~~~

Не копируйте токены, одноразовые коды или содержимое .npmrc в Issues, документы или чат.
Ни workflow, ни исходники не должны содержать ключ для публикации. Владение именем
проверяется npm при реальной публикации; прежний E404 не резервирует имя.

После окончательного решения о публикации — из корня SDK, именно проверенный архив:

~~~powershell
$uldaReceipt = Get-Content -Raw .local/release/publish-check.json | ConvertFrom-Json
$uldaArchive = './.local/release/ulda-auth-1.0.0.tgz'
$uldaHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $uldaArchive).Hash.ToLowerInvariant()
if ($uldaReceipt.name -ne 'ulda-auth' -or $uldaReceipt.version -ne '1.0.0' -or
    $uldaReceipt.dryRun -ne $true -or $uldaReceipt.sha256 -ne $uldaHash) {
  throw 'Archive differs from the checked release.'
}
npm publish $uldaArchive --ignore-scripts --access public --tag latest --registry=https://registry.npmjs.org/
~~~

--ignore-scripts здесь сохраняет уже проверенные байты, вместо пересборки из рабочей
папки. Самостоятельно npm publish из корня не заменяет этот порядок. npm может
запросить дополнительную проверку аккаунта. Версию name@version нельзя использовать
повторно, даже после unpublish: поэтому фактическая отправка отделена от подготовки.

После успеха проверьте npm view ulda-auth@1.0.0 dist.integrity --registry=https://registry.npmjs.org/
и сравните с integrity в publish-check.json. Запишите факт/дату публикации, создайте
аннотированный v1.0.0 на проверенном коммите и отправьте только этот тег.
Изменения опубликованного пакета требуют следующей версии.

## 4. Следующие релизы

Автоматическую публикацию сейчас не включали. Позже можно настроить npm Trusted
Publishing через GitHub Actions/OIDC с отдельным разрешённым workflow и environment.
Для него нужен npm >=11.5.1; текущий локальный npm 10.9.3 используется для ручного dry-run.
Настройка в npm и подходящий runner обязательны, одного workflow недостаточно.

Источники: [npm publish](https://docs.npmjs.com/cli/v11/commands/npm-publish/),
[npm Trusted Publishers](https://docs.npmjs.com/trusted-publishers/).
